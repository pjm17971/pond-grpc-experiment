/**
 * Drift-comparison harness for the milestone-B late-data driver.
 *
 * Runs the producer + aggregator twice with the same workload and
 * RNG seed, once with `LATE_EVENT_FRACTION=0` (clean baseline) and
 * once with the configured `--late-fraction` (late-loaded). Both
 * legs ship the same wall-clock duration of events; the script
 * scrapes `/metrics → late.*` from each leg and prints a
 * side-by-side comparison.
 *
 * The friction note's payoff scenario is the **drift between legs**:
 * if pond's rolling pipelines were repairing late events correctly,
 * `cpu_avg` per host would converge between the two legs (the late
 * events change WHEN they land in pond's view but not WHAT statistic
 * they contribute to the rolling). Because pond's rolling does NOT
 * repair, the late-loaded leg's per-host `cpu_avg` differs from the
 * baseline by an amount that depends on the producer's host bias
 * and the late-event arrival distribution.
 *
 * The harness also drives the aggregator's `live.stats()` +
 * experiment-side `late.*` counters into a single JSON envelope so
 * the friction note can include a copy-pasteable readout.
 *
 *   pnpm exec tsx scripts/drift-late-data.ts \
 *     --hosts=20 --eps=2000 --seconds=120 \
 *     --late-fraction=0.05 --host-bias=api-3:0.5
 *
 * Default workload mirrors the dashboard's normal mode (8 events/s
 * per host, 4 hosts, 30s) — fast enough to iterate, slow enough to
 * run on a laptop without thermal throttle.
 */

import {
  allocatePort,
  spawnAggregator,
  spawnProducer,
  type SpawnedProcess,
} from '@pond-experiment/dev-utils';
import WebSocket from 'ws';
import {
  decode,
  type AggregateAppendMsg,
  type GlobalsTick,
  type HostTick,
  type WireMsg,
} from '@pond-experiment/shared';
import type { MetricsSnapshot } from '../src/metrics.js';

type Args = {
  hosts: number;
  eventsPerSec: number;
  seconds: number;
  lateFraction: number;
  lateDelayMs: number;
  lateDelayTailMs: number;
  hostBias: string | undefined;
  seed: number;
  warmupSec: number;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (k: string): string | undefined => {
    const prefix = `--${k}=`;
    return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };
  return {
    hosts: Number(get('hosts') ?? '4'),
    eventsPerSec: Number(get('eps') ?? '8'),
    seconds: Number(get('seconds') ?? '30'),
    lateFraction: Number(get('late-fraction') ?? '0.05'),
    lateDelayMs: Number(get('late-delay-ms') ?? '5000'),
    lateDelayTailMs: Number(get('late-delay-tail-ms') ?? '15000'),
    hostBias: get('host-bias'),
    seed: Number(get('seed') ?? '1'),
    warmupSec: Number(get('warmup-sec') ?? '5'),
  };
}

async function fetchMetrics(port: number): Promise<MetricsSnapshot> {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!r.ok) throw new Error(`/metrics returned ${r.status}`);
  return (await r.json()) as MetricsSnapshot;
}

type ProducerMetrics = {
  events_emitted_total: number;
  events_emitted_late_total: number;
  lateness_p50_ms: number;
  lateness_p99_ms: number;
  lateness_samples_count: number;
};

async function fetchProducerMetrics(
  port: number,
): Promise<ProducerMetrics | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/metrics`);
    if (!r.ok) return null;
    return (await r.json()) as ProducerMetrics;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LegResult = {
  label: string;
  metrics: MetricsSnapshot;
  producerMetrics: ProducerMetrics | null;
  /** Last-tick per-host `cpu_avg`, captured from the live-agg stream. */
  finalCpuAvgByHost: Record<string, number | null>;
  /** Last-tick globals — `events_per_sec`, `events_ingested_total` etc. */
  finalGlobals: GlobalsTick | null;
};

/**
 * Run one leg of the comparison. Spins up producer + aggregator,
 * waits for warmup, runs for `args.seconds`, scrapes /metrics from
 * both, captures the last `aggregate-append` for per-host cpu_avg.
 */
async function runLeg(
  label: string,
  args: Args,
  applyLateInjection: boolean,
): Promise<LegResult> {
  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();
  const producerMetricsPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;
  let aggProbe: WebSocket | undefined;
  let lastFrame: AggregateAppendMsg | null = null;

  console.log(
    `\n── leg: ${label} (late-fraction=${applyLateInjection ? args.lateFraction : 0}) ──`,
  );

  try {
    producer = await spawnProducer({
      grpcPort,
      eventsPerSec: args.eventsPerSec,
      hostCount: args.hosts,
      lateEventFraction: applyLateInjection ? args.lateFraction : 0,
      lateEventDelayMs: args.lateDelayMs,
      lateEventDelayTailMs: args.lateDelayTailMs,
      lateEventHostBias: args.hostBias,
      lateEventSeed: args.seed,
      metricsPort: producerMetricsPort,
    });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
      // Reorder mode under both legs so the aggregator behaves
      // identically structurally — the only A/B variable is whether
      // the producer emits late events.
      ordering: 'reorder',
      graceWindowMs: 30_000,
    });

    aggProbe = new WebSocket(`ws://127.0.0.1:${httpPort}/live-agg`);
    await new Promise<void>((res, rej) => {
      aggProbe!.on('open', () => res());
      aggProbe!.on('error', rej);
    });
    aggProbe.on('message', (data) => {
      const msg = decode(data.toString()) as WireMsg;
      if (msg.type === 'aggregate-append') {
        lastFrame = msg as AggregateAppendMsg;
      }
    });

    console.log(`  warmup ${args.warmupSec}s…`);
    await sleep(args.warmupSec * 1000);
    console.log(`  measuring ${args.seconds}s…`);
    await sleep(args.seconds * 1000);

    const metrics = await fetchMetrics(httpPort);
    const producerMetrics = applyLateInjection
      ? await fetchProducerMetrics(producerMetricsPort)
      : null;

    const finalCpuAvgByHost: Record<string, number | null> = {};
    if (lastFrame) {
      for (const row of (lastFrame as AggregateAppendMsg).rows as ReadonlyArray<HostTick>) {
        finalCpuAvgByHost[row.host] = row.cpu_avg;
      }
    }
    const finalGlobals = lastFrame
      ? ((lastFrame as AggregateAppendMsg).globals ?? null)
      : null;

    return {
      label,
      metrics,
      producerMetrics,
      finalCpuAvgByHost,
      finalGlobals,
    };
  } finally {
    aggProbe?.close();
    if (aggregator) await aggregator.stop('SIGTERM');
    if (producer) await producer.stop('SIGTERM');
  }
}

function formatRow(label: string, baseline: string, late: string): string {
  return (
    label.padEnd(38) +
    baseline.padStart(15) +
    '   ' +
    late.padStart(15)
  );
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(num: number, den: number): string {
  if (den === 0) return '—';
  return ((num / den) * 100).toFixed(2) + '%';
}

function diff(baseline: number | null, late: number | null): string {
  if (baseline === null || late === null) return '—';
  const d = late - baseline;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(4)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `drift-late-data — hosts=${args.hosts}, eps=${args.eventsPerSec}/s/host, ` +
      `seconds=${args.seconds}, late-fraction=${args.lateFraction}, ` +
      `delay=(median=${args.lateDelayMs}ms, p99=${args.lateDelayTailMs}ms), ` +
      `host-bias=${args.hostBias ?? '(none)'}, seed=${args.seed}`,
  );

  const baseline = await runLeg('clean baseline', args, false);
  const late = await runLeg('late-loaded', args, true);

  // ── Report ──────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('LATE-DATA DRIFT REPORT');
  console.log('══════════════════════════════════════════════════════════════════════\n');
  console.log(formatRow('', 'clean baseline', 'late-loaded'));
  console.log('─'.repeat(72));

  // Producer counters
  const bp = baseline.producerMetrics;
  const lp = late.producerMetrics;
  console.log(
    formatRow(
      'producer events_emitted_total',
      bp ? num(bp.events_emitted_total) : 'n/a (frac=0)',
      lp ? num(lp.events_emitted_total) : 'n/a',
    ),
  );
  console.log(
    formatRow(
      'producer events_emitted_late_total',
      bp ? num(bp.events_emitted_late_total) : 'n/a',
      lp ? num(lp.events_emitted_late_total) : 'n/a',
    ),
  );
  if (lp) {
    const latePct = lp.events_emitted_total
      ? pct(lp.events_emitted_late_total, lp.events_emitted_total)
      : '—';
    console.log(
      formatRow('  → producer late fraction (actual)', '', latePct),
    );
    console.log(
      formatRow(
        '  producer lateness p50/p99 ms',
        '',
        `${lp.lateness_p50_ms}/${lp.lateness_p99_ms}`,
      ),
    );
  }
  console.log('');

  // Aggregator pond stats
  const bs = baseline.metrics.late.liveStats;
  const ls = late.metrics.late.liveStats;
  console.log(
    formatRow('pond.stats().ingested', num(bs.ingested), num(ls.ingested)),
  );
  console.log(
    formatRow('pond.stats().rejected', num(bs.rejected), num(ls.rejected)),
  );
  console.log(
    formatRow('pond.stats().evicted', num(bs.evicted), num(ls.evicted)),
  );
  console.log('');

  // Late-event correctness counters (the milestone-B headline)
  const bl = baseline.metrics.late;
  const ll = late.metrics.late;
  console.log(
    formatRow(
      'late.eventsLateAtIngestTotal',
      num(bl.eventsLateAtIngestTotal),
      num(ll.eventsLateAtIngestTotal),
    ),
  );
  console.log(
    formatRow(
      '  of which: within-baseline (1m)',
      num(bl.eventsLateWithinBaselineTotal),
      num(ll.eventsLateWithinBaselineTotal),
    ),
  );
  console.log(
    formatRow(
      '  of which: past-baseline (>60s)',
      num(bl.eventsLatePastBaselineTotal),
      num(ll.eventsLatePastBaselineTotal),
    ),
  );
  console.log(
    formatRow(
      '  of which: past-grace (>30s)',
      num(bl.eventsLatePastGraceTotal),
      num(ll.eventsLatePastGraceTotal),
    ),
  );
  console.log(
    formatRow(
      'late.pondInsertThrowsTotal',
      num(bl.pondInsertThrowsTotal),
      num(ll.pondInsertThrowsTotal),
    ),
  );
  if (ll.latencyBehindHighWaterMs) {
    console.log(
      formatRow(
        'late.lag p50/p99 ms',
        bl.latencyBehindHighWaterMs
          ? `${bl.latencyBehindHighWaterMs.p50.toFixed(0)}/${bl.latencyBehindHighWaterMs.p99.toFixed(0)}`
          : '—',
        `${ll.latencyBehindHighWaterMs.p50.toFixed(0)}/${ll.latencyBehindHighWaterMs.p99.toFixed(0)}`,
      ),
    );
  }
  console.log('');

  // Per-host within-baseline lateness counts
  if (Object.keys(ll.lateWithinBaselineByHost).length > 0) {
    console.log('late-events within baseline window, by host (late-loaded leg):');
    const entries = Object.entries(ll.lateWithinBaselineByHost).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [host, count] of entries) {
      console.log(`  ${host.padEnd(20)} ${num(count).padStart(8)}`);
    }
    console.log('');
  }

  // Per-host cpu_avg drift (the milestone-B payoff)
  console.log(
    'per-host cpu_avg drift (last-tick value, late-loaded - clean baseline):',
  );
  const allHosts = new Set([
    ...Object.keys(baseline.finalCpuAvgByHost),
    ...Object.keys(late.finalCpuAvgByHost),
  ]);
  const driftRows: Array<{ host: string; baseline: number | null; late: number | null; drift: number | null }> = [];
  for (const host of [...allHosts].sort()) {
    const b = baseline.finalCpuAvgByHost[host] ?? null;
    const l = late.finalCpuAvgByHost[host] ?? null;
    const d = b !== null && l !== null ? l - b : null;
    driftRows.push({ host, baseline: b, late: l, drift: d });
  }
  // Sort by absolute drift descending so biased hosts surface first.
  driftRows.sort((a, b) => Math.abs(b.drift ?? 0) - Math.abs(a.drift ?? 0));
  for (const r of driftRows) {
    console.log(
      `  ${r.host.padEnd(20)} baseline=${(r.baseline ?? NaN).toFixed(4).padStart(8)}` +
        `   late=${(r.late ?? NaN).toFixed(4).padStart(8)}` +
        `   drift=${diff(r.baseline, r.late).padStart(10)}`,
    );
  }
  console.log('');

  // Final globals
  if (baseline.finalGlobals && late.finalGlobals) {
    console.log(
      formatRow(
        'globals.events_per_sec (last)',
        num(baseline.finalGlobals.events_per_sec),
        num(late.finalGlobals.events_per_sec),
      ),
    );
    console.log(
      formatRow(
        'globals.events_ingested_total (last)',
        num(baseline.finalGlobals.events_ingested_total),
        num(late.finalGlobals.events_ingested_total),
      ),
    );
  }
  console.log('');

  // Conservation check
  if (lp) {
    const conservationLate =
      ls.ingested + ll.pondInsertThrowsTotal + ls.rejected;
    const expectedLate = lp.events_emitted_total;
    const drift = expectedLate
      ? Math.abs(conservationLate - expectedLate) / expectedLate
      : 0;
    console.log(
      `conservation (late-loaded leg): pond.ingested + insert-throws + ` +
        `pond.rejected = ${num(conservationLate)} vs producer.emitted = ` +
        `${num(expectedLate)} (${(drift * 100).toFixed(2)}% drift; ` +
        `≤1% is fine, larger means events lost in transit)`,
    );
  }
}

await main();
