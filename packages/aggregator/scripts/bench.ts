import { writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocatePort,
  spawnAggregator,
  spawnProducer,
  type SpawnedProcess,
} from '@pond-experiment/dev-utils';
import WebSocket from 'ws';
import type { MetricsSnapshot } from '../src/metrics.js';

/**
 * M3 throughput bench. Two modes:
 * - `pnpm bench:dev` — one config (default P=100, N=10), 30s, prints
 *   one row to stdout. Optional CLI: `--P=N --N=N --seconds=N`.
 * - `pnpm bench:full` — the PLAN.md sweep `P ∈ {10,100,1000} ×
 *   N ∈ {1,10,100,1000}`, 60s per config, writes BENCH.md.
 *
 * Each run:
 *   1. allocates two TCP ports (gRPC + HTTP)
 *   2. spawns producer (rate=N events/sec/host, hosts=P)
 *   3. spawns aggregator (dials producer, exposes /metrics)
 *   4. opens one WS probe so the fanout has a consumer
 *   5. warms 5s, samples /metrics every 1s for `duration` seconds
 *   6. tears down + computes aggregate stats
 *
 * The library bench reference (peer table from the M3 plan):
 *
 * | P    | N=1  | N=10 | N=100 |
 * | ---- | ---- | ---- | ----- |
 * | 1    | 16k  | 175k | 227k  |
 * | 10   | 267k | 437k | 494k  |
 * | 100  | 273k | 538k | 520k  |
 * | 1000 | 371k | 435k | 353k  |
 *
 * Where the experiment's per-event-push ingest in M2 maps to N=1
 * (one push per Event). Phase 5 of M3 lands a macrotask-coalesced
 * `pushMany` and the after-batching column should approach the
 * library's N=10/N=100 cells.
 */

const SWEEP: ReadonlyArray<{ P: number; N: number }> = [
  { P: 10, N: 1 }, { P: 10, N: 10 }, { P: 10, N: 100 }, { P: 10, N: 1000 },
  { P: 100, N: 1 }, { P: 100, N: 10 }, { P: 100, N: 100 }, { P: 100, N: 1000 },
  { P: 1000, N: 1 }, { P: 1000, N: 10 }, { P: 1000, N: 100 }, { P: 1000, N: 1000 },
];

type Result = {
  P: number;
  N: number;
  targetTotalRate: number;
  achievedTotalRate: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  gcMajorCount: number;
  gcMajorTotalMs: number;
  gcMinorCount: number;
  gcMinorTotalMs: number;
  heapPeakMb: number;
  /** Events the aggregator received from gRPC but never made it to fanout. */
  arrivalQueueResidual: number;
  /** Average number of events per `live.pushMany(rows)` invocation. */
  pushManyAvgBatch: number;
  pushManyMaxBatch: number;
  /** Per-phase wall-clock breakdown at p99 (ms). */
  pushManyTotalP99: number;
  fanoutRecordP99: number;
  fanoutSerializeP99: number;
  fanoutBroadcastP99: number;
};

async function runConfig(
  cfg: { P: number; N: number },
  durationSec = 60,
): Promise<Result> {
  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;
  let probe: WebSocket | undefined;

  try {
    producer = await spawnProducer({
      grpcPort,
      eventsPerSec: cfg.N,
      hostCount: cfg.P,
    });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
    });
    probe = new WebSocket(`ws://127.0.0.1:${httpPort}/live`);
    await new Promise<void>((res, rej) => {
      probe!.on('open', () => res());
      probe!.on('error', rej);
    });

    // Warm up — let the gRPC stream open, the WS connect, and the
    // first batches drain so the steady-state is what we measure.
    await sleep(5000);

    const baseline = await fetchMetrics(httpPort);
    const samples: MetricsSnapshot[] = [baseline];
    const startedAt = Date.now();
    while (Date.now() - startedAt < durationSec * 1000) {
      await sleep(1000);
      try {
        samples.push(await fetchMetrics(httpPort));
      } catch (err) {
        console.warn(`[P=${cfg.P} N=${cfg.N}] metrics scrape failed: ${(err as Error).message}`);
      }
    }
    const final = samples[samples.length - 1];

    const elapsedSec = final.uptimeSec - baseline.uptimeSec;
    const eventsDelta = final.events.fannedOut - baseline.events.fannedOut;
    const achievedTotalRate = elapsedSec > 0 ? eventsDelta / elapsedSec : 0;

    const lat = final.latency.ingestToFanoutMs ?? {
      p50: 0,
      p95: 0,
      p99: 0,
      count: 0,
    };
    const p99 = (
      h: { p99: number } | null,
    ): number => h?.p99 ?? 0;
    const gcMajorBaseline = baseline.gc.major ?? { count: 0, totalMs: 0, maxMs: 0 };
    const gcMajorFinal = final.gc.major ?? { count: 0, totalMs: 0, maxMs: 0 };
    const gcMinorBaseline = baseline.gc.minor ?? { count: 0, totalMs: 0, maxMs: 0 };
    const gcMinorFinal = final.gc.minor ?? { count: 0, totalMs: 0, maxMs: 0 };
    const heapPeakBytes = Math.max(...samples.map((s) => s.memory.heapUsed));

    const pmCallsDelta = final.pushMany.calls - baseline.pushMany.calls;
    const pmEventsDelta =
      final.pushMany.totalEvents - baseline.pushMany.totalEvents;

    return {
      P: cfg.P,
      N: cfg.N,
      targetTotalRate: cfg.P * cfg.N,
      achievedTotalRate: Math.round(achievedTotalRate),
      latencyP50: lat.p50,
      latencyP95: lat.p95,
      latencyP99: lat.p99,
      gcMajorCount: gcMajorFinal.count - gcMajorBaseline.count,
      gcMajorTotalMs: gcMajorFinal.totalMs - gcMajorBaseline.totalMs,
      gcMinorCount: gcMinorFinal.count - gcMinorBaseline.count,
      gcMinorTotalMs: gcMinorFinal.totalMs - gcMinorBaseline.totalMs,
      heapPeakMb: Math.round(heapPeakBytes / 1024 / 1024),
      arrivalQueueResidual: final.arrivalQueueLength,
      pushManyAvgBatch:
        pmCallsDelta === 0 ? 0 : pmEventsDelta / pmCallsDelta,
      pushManyMaxBatch: final.pushMany.maxBatchSize,
      pushManyTotalP99: p99(final.latency.pushManyTotalMs),
      fanoutRecordP99: p99(final.latency.fanoutRecordMs),
      fanoutSerializeP99: p99(final.latency.fanoutSerializeMs),
      fanoutBroadcastP99: p99(final.latency.fanoutBroadcastMs),
    };
  } finally {
    probe?.close();
    if (aggregator) await aggregator.stop('SIGTERM');
    if (producer) await producer.stop('SIGTERM');
  }
}

async function fetchMetrics(port: number): Promise<MetricsSnapshot> {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!r.ok) throw new Error(`/metrics returned ${r.status}`);
  return (await r.json()) as MetricsSnapshot;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TABLE_HEADER = [
  '| P | N | Target/s | Achieved/s | e2e p99 ms | pushMany p99 | fanout record p99 | fanout serialize p99 | fanout send p99 | GC major | GC minor | Heap peak | Avg batch | Residual |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function formatRow(r: Result): string {
  const num = (n: number): string => n.toLocaleString('en-US');
  return [
    `| ${r.P}`,
    `${r.N}`,
    num(r.targetTotalRate),
    num(r.achievedTotalRate),
    r.latencyP99.toFixed(2),
    r.pushManyTotalP99.toFixed(2),
    r.fanoutRecordP99.toFixed(2),
    r.fanoutSerializeP99.toFixed(2),
    r.fanoutBroadcastP99.toFixed(2),
    `${r.gcMajorCount} / ${r.gcMajorTotalMs.toFixed(0)}ms`,
    `${r.gcMinorCount} / ${r.gcMinorTotalMs.toFixed(0)}ms`,
    `${r.heapPeakMb} MB`,
    r.pushManyAvgBatch.toFixed(1),
    `${r.arrivalQueueResidual} |`,
  ].join(' | ');
}

function parseArg(args: ReadonlyArray<string>, key: string): string | undefined {
  const prefix = `--${key}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isFull = args.includes('--full');

  if (isFull) {
    const seconds = Number(parseArg(args, 'seconds') ?? '60');
    console.log(`bench:full — running ${SWEEP.length} configs, ${seconds}s each`);
    console.log(`expected total runtime: ~${Math.round((SWEEP.length * (seconds + 10)) / 60)} minutes\n`);
    const rows: Result[] = [];
    for (const cfg of SWEEP) {
      console.log(`[${rows.length + 1}/${SWEEP.length}] P=${cfg.P}, N=${cfg.N} — running…`);
      try {
        const r = await runConfig(cfg, seconds);
        rows.push(r);
        console.log(`  achieved ${r.achievedTotalRate.toLocaleString()}/s, p99 ${r.latencyP99.toFixed(1)}ms`);
      } catch (err) {
        console.error(`  FAILED: ${(err as Error).message}`);
        // Push a sentinel row so the table reflects the failure.
        rows.push({
          P: cfg.P,
          N: cfg.N,
          targetTotalRate: cfg.P * cfg.N,
          achievedTotalRate: -1,
          latencyP50: 0,
          latencyP95: 0,
          latencyP99: 0,
          gcMajorCount: 0,
          gcMajorTotalMs: 0,
          gcMinorCount: 0,
          gcMinorTotalMs: 0,
          heapPeakMb: 0,
          arrivalQueueResidual: -1,
          pushManyAvgBatch: 0,
          pushManyMaxBatch: 0,
          pushManyTotalP99: 0,
          fanoutRecordP99: 0,
          fanoutSerializeP99: 0,
          fanoutBroadcastP99: 0,
        });
      }
    }

    const benchPath = resolvePath(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'BENCH.md',
    );
    const md = [
      '# M3 throughput bench',
      '',
      `Generated by \`pnpm bench:full --seconds=${seconds}\` at ${new Date().toISOString()}.`,
      '',
      `Each config: producer + aggregator + 1 WS probe, 5s warmup, ${seconds}s measurement.`,
      'See `scripts/bench.ts` for the methodology.',
      '',
      TABLE_HEADER,
      ...rows.map(formatRow),
      '',
    ].join('\n');
    writeFileSync(benchPath, md);
    console.log(`\nWrote ${benchPath}`);
  } else {
    const P = Number(parseArg(args, 'P') ?? '100');
    const N = Number(parseArg(args, 'N') ?? '10');
    const seconds = Number(parseArg(args, 'seconds') ?? '30');
    console.log(`bench:dev — P=${P}, N=${N}, duration=${seconds}s`);
    const r = await runConfig({ P, N }, seconds);
    console.log('');
    console.log(TABLE_HEADER);
    console.log(formatRow(r));
  }
}

await main();
