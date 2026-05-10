/**
 * Drift-comparison harness for the milestone-B late-data driver.
 *
 * Runs the producer + aggregator multiple times across two legs —
 * `LATE_EVENT_FRACTION=0` (clean baseline) and the configured
 * `--late-fraction` (late-loaded) — and reports per-host `cpu_avg`
 * drift between legs WITH a noise-floor estimate from run-to-run
 * variance within the clean baseline leg.
 *
 * The point: a single A/B run can't separate "drift caused by
 * pond's rolling-no-repair gap" from "drift caused by tick
 * scheduling jitter between two runs of the same workload." The
 * library agent's M4 review flagged this confound. Multi-replicate
 * gives us mean ± stdev per leg per host, and a `signal/noise`
 * ratio that says "the late-loaded mean differs from the clean-
 * baseline mean by N× the run-to-run variance of clean-baseline
 * itself." Drifts above ~2σ are confidently real; below ~2σ are
 * within the noise floor.
 *
 * Replicate seeds: `--seed=N` is the base seed; replicate `i` (1-
 * indexed) uses `seed + i - 1`. So `--replicates=3 --seed=1` runs
 * with seeds 1, 2, 3.
 *
 *   pnpm exec tsx scripts/drift-late-data.ts \
 *     --hosts=4 --eps=10 --seconds=60 --replicates=3 \
 *     --late-fraction=0.1 --host-bias=api-1:0.5 --seed=1
 *
 * Wall-clock: replicates × 2 legs × (warmup + measure) seconds.
 * At defaults (replicates=3, seconds=60, warmup=5) that's ~6.5
 * minutes total. Set `--replicates=1` for quick iteration; the
 * report degrades to the single-run shape (no noise floor, just
 * the drift number).
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
  replicates: number;
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
    replicates: Math.max(1, Number(get('replicates') ?? '3')),
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
  seed: number;
  metrics: MetricsSnapshot;
  producerMetrics: ProducerMetrics | null;
  /** Last-tick per-host `cpu_avg`, captured from the live-agg stream. */
  finalCpuAvgByHost: Record<string, number | null>;
  /** Last-tick globals — `events_per_sec`, `events_ingested_total` etc. */
  finalGlobals: GlobalsTick | null;
};

/**
 * Run one replicate of one leg. Spins up producer + aggregator,
 * waits for warmup, runs for `args.seconds`, scrapes /metrics from
 * both, captures the last `aggregate-append` for per-host cpu_avg.
 */
async function runLeg(
  label: string,
  args: Args,
  applyLateInjection: boolean,
  seed: number,
): Promise<LegResult> {
  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();
  const producerMetricsPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;
  let aggProbe: WebSocket | undefined;
  let lastFrame: AggregateAppendMsg | null = null;

  console.log(
    `  ── leg: ${label} (seed=${seed}, late-fraction=${applyLateInjection ? args.lateFraction : 0}) ──`,
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
      lateEventSeed: seed,
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

    await sleep(args.warmupSec * 1000);
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
      seed,
      metrics,
      producerMetrics,
      finalCpuAvgByHost,
      finalGlobals,
    };
  } finally {
    aggProbe?.close();
    // Stop the producer FIRST so its shutdown handler can drain the
    // late-injector setTimeout queue before the gRPC stream closes.
    // Producer's shutdown runs `lateInjector.drain()` then 200ms
    // sleep then closes — so the held events make it onto the wire
    // and the conservation check closes exactly. Stopping the
    // aggregator first would close the wire mid-drain.
    if (producer) await producer.stop('SIGTERM');
    if (aggregator) await aggregator.stop('SIGTERM');
  }
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(num: number, den: number): string {
  if (den === 0) return '—';
  return ((num / den) * 100).toFixed(2) + '%';
}

function formatRow(label: string, baseline: string, late: string): string {
  return (
    label.padEnd(38) + baseline.padStart(15) + '   ' + late.padStart(15)
  );
}

/** Sample mean (ignoring null entries). */
function mean(values: ReadonlyArray<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Sample standard deviation (Bessel-corrected). Returns null when
 * fewer than 2 finite samples — variance is undefined for n<2.
 */
function stdev(values: ReadonlyArray<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (xs.length - 1));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const totalLegs = args.replicates * 2;
  const estimatedSec = totalLegs * (args.warmupSec + args.seconds);
  console.log(
    `drift-late-data — hosts=${args.hosts}, eps=${args.eventsPerSec}/s/host, ` +
      `seconds=${args.seconds}, replicates=${args.replicates}, ` +
      `late-fraction=${args.lateFraction}, ` +
      `delay=(median=${args.lateDelayMs}ms, p99=${args.lateDelayTailMs}ms), ` +
      `host-bias=${args.hostBias ?? '(none)'}, base-seed=${args.seed}\n` +
      `  estimated wall-clock: ~${Math.round(estimatedSec)}s ` +
      `(${totalLegs} legs × ~${args.warmupSec + args.seconds}s each)`,
  );

  const baselineRuns: LegResult[] = [];
  const lateRuns: LegResult[] = [];
  for (let i = 0; i < args.replicates; i++) {
    const seed = args.seed + i;
    console.log(`\nreplicate ${i + 1}/${args.replicates} (seed=${seed})`);
    baselineRuns.push(await runLeg('clean baseline', args, false, seed));
    lateRuns.push(await runLeg('late-loaded', args, true, seed));
  }

  // ── Aggregate per-host across replicates ───────────────────────
  const allHosts = new Set<string>();
  for (const r of [...baselineRuns, ...lateRuns]) {
    for (const h of Object.keys(r.finalCpuAvgByHost)) allHosts.add(h);
  }
  type HostStats = {
    host: string;
    baseline: ReadonlyArray<number | null>;
    late: ReadonlyArray<number | null>;
    baselineMean: number | null;
    baselineSd: number | null;
    lateMean: number | null;
    lateSd: number | null;
    drift: number | null;
    /** drift / baselineSd — 2σ+ is confidently real. */
    driftSigmas: number | null;
  };
  const hostStats: HostStats[] = [];
  for (const host of [...allHosts].sort()) {
    const baseline = baselineRuns.map((r) => r.finalCpuAvgByHost[host] ?? null);
    const late = lateRuns.map((r) => r.finalCpuAvgByHost[host] ?? null);
    const baselineMean = mean(baseline);
    const baselineSd = stdev(baseline);
    const lateMean = mean(late);
    const lateSd = stdev(late);
    const drift =
      baselineMean !== null && lateMean !== null
        ? lateMean - baselineMean
        : null;
    const driftSigmas =
      drift !== null && baselineSd !== null && baselineSd > 0
        ? drift / baselineSd
        : null;
    hostStats.push({
      host,
      baseline,
      late,
      baselineMean,
      baselineSd,
      lateMean,
      lateSd,
      drift,
      driftSigmas,
    });
  }

  // ── Report ─────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('LATE-DATA DRIFT REPORT');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  // Headline counters from the LAST replicate of each leg (the
  // raw counter readout — these are pinned per-replicate, not
  // aggregated across replicates because they're cumulative within
  // a single process lifetime).
  const baseline = baselineRuns[baselineRuns.length - 1];
  const late = lateRuns[lateRuns.length - 1];
  console.log(
    `(headline counters from replicate ${args.replicates}; per-host stats below aggregate across all ${args.replicates} replicates)`,
  );
  console.log('');
  console.log(formatRow('', 'clean baseline', 'late-loaded'));
  console.log('─'.repeat(72));

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
      '  of which: within-rolling-window (1m)',
      num(bl.eventsLateWithinRollingWindowTotal),
      num(ll.eventsLateWithinRollingWindowTotal),
    ),
  );
  console.log(
    formatRow(
      '  of which: past-rolling-window (>60s)',
      num(bl.eventsLatePastRollingWindowTotal),
      num(ll.eventsLatePastRollingWindowTotal),
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

  // Per-host within-rolling-window lateness counts (last replicate)
  if (Object.keys(ll.lateWithinRollingWindowByHost).length > 0) {
    console.log('late-events within rolling window, by host (replicate ' + args.replicates + '):');
    const entries = Object.entries(ll.lateWithinRollingWindowByHost).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [host, count] of entries) {
      console.log(`  ${host.padEnd(20)} ${num(count).padStart(8)}`);
    }
    console.log('');
  }

  // Per-host cpu_avg drift with noise floor (the milestone-B payoff)
  console.log(
    `per-host cpu_avg drift (mean ± stdev across ${args.replicates} replicates):`,
  );
  console.log(
    '  host                 baseline        late            drift     drift/σ_baseline',
  );
  console.log('  ' + '─'.repeat(82));

  // Sort by absolute drift descending so biased hosts surface first.
  const sortedHostStats = [...hostStats].sort(
    (a, b) => Math.abs(b.drift ?? 0) - Math.abs(a.drift ?? 0),
  );
  for (const r of sortedHostStats) {
    const fmt = (v: number | null) =>
      v === null ? '   —   ' : v.toFixed(4);
    const fmtSd = (v: number | null) =>
      v === null ? '—' : `±${v.toFixed(4)}`;
    const sigmaStr =
      r.driftSigmas === null
        ? '—'
        : `${r.driftSigmas >= 0 ? '+' : ''}${r.driftSigmas.toFixed(2)}σ`;
    const interp =
      r.driftSigmas === null
        ? ''
        : Math.abs(r.driftSigmas) >= 2
          ? '   ← > 2σ (real)'
          : Math.abs(r.driftSigmas) >= 1
            ? '   (~1σ, marginal)'
            : '   (within noise)';
    console.log(
      `  ${r.host.padEnd(20)} ${fmt(r.baselineMean)} ${fmtSd(r.baselineSd).padStart(9)}` +
        `  ${fmt(r.lateMean)} ${fmtSd(r.lateSd).padStart(9)}` +
        `  ${(r.drift !== null ? (r.drift >= 0 ? '+' : '') + r.drift.toFixed(4) : '   —   ').padStart(8)}` +
        `   ${sigmaStr.padStart(8)}${interp}`,
    );
  }
  console.log('');

  // Noise-floor headline. Largest baseline stdev across hosts —
  // the most volatile clean run, useful as "you should worry
  // about drifts up to this magnitude on a single A/B."
  const maxBaselineSd = Math.max(
    ...hostStats
      .map((s) => s.baselineSd)
      .filter((v): v is number => v !== null),
    0,
  );
  console.log(
    `noise floor (max baseline-leg stdev across hosts): ` +
      `${maxBaselineSd.toFixed(4)} (cpu_avg units)`,
  );
  console.log('');

  // Final globals (last replicate)
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

  // Conservation check — averaged across replicates
  if (lateRuns.every((r) => r.producerMetrics !== null)) {
    let totalConserved = 0;
    let totalEmitted = 0;
    for (const r of lateRuns) {
      const lm = r.metrics.late;
      const lp = r.producerMetrics!;
      totalConserved +=
        lm.liveStats.ingested +
        lm.pondInsertThrowsTotal +
        lm.liveStats.rejected;
      totalEmitted += lp.events_emitted_total;
    }
    const drift = totalEmitted
      ? Math.abs(totalConserved - totalEmitted) / totalEmitted
      : 0;
    console.log(
      `conservation (across ${args.replicates} late-loaded replicates): ` +
        `pond.ingested + insert-throws + pond.rejected = ${num(totalConserved)} ` +
        `vs producer.emitted = ${num(totalEmitted)} ` +
        `(${(drift * 100).toFixed(2)}% drift; ≤0.5% indicates the ` +
        `injector drain on shutdown is working)`,
    );
  }
}

await main();
