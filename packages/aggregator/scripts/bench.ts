import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /**
   * Rows/s the producer dropped because the aggregator fell 64 batches
   * behind (producer `/metrics`). Before the producers had a bounded
   * queue this showed up nowhere: the backlog just grew. -1 (shown as
   * n/a) when the producer has no `/metrics`.
   */
  droppedTotalRate: number;
  /**
   * WebSocket bytes/sec the probe actually received in the window, and
   * whether it was still connected at the end. `Achieved/s` counts
   * server-side fan-out calls, which keep rising with no client
   * attached, so it only means "delivered" while the probe is up.
   */
  probeMbPerSec: number;
  /**
   * CPU the aggregator used over the measurement, in cores (1.0 = one
   * core busy the whole time), summed over its process group. -1 where
   * `/proc` isn't available (macOS).
   */
  aggCpuCores: number;
  probeConnected: boolean;
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
  const producerMetricsPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;
  let probe: WebSocket | undefined;

  try {
    producer = await spawnProducer({
      grpcPort,
      eventsPerSec: cfg.N,
      hostCount: cfg.P,
      metricsPort: producerMetricsPort,
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

    let probeBytes = 0;
    probe.on('message', (data: Buffer) => {
      probeBytes += data.length;
    });

    // null: a producer without `/metrics` (an older build).
    const producerBaseline = await fetchProducerMetrics(
      producerMetricsPort,
    ).catch(() => null);
    const cpuStart = groupCpuSec(aggregator.pid);
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
    const cpuEnd = groupCpuSec(aggregator.pid);
    const producerFinal = await fetchProducerMetrics(
      producerMetricsPort,
    ).catch(() => null);
    const producerSec =
      producerBaseline && producerFinal
        ? producerFinal.uptimeSec - producerBaseline.uptimeSec
        : 0;
    const droppedTotalRate =
      producerBaseline && producerFinal && producerSec > 0
        ? (producerFinal.droppedRows - producerBaseline.droppedRows) /
          producerSec
        : -1;
    const probeConnected =
      probe.readyState === WebSocket.OPEN && final.ws.clientCount >= 1;
    if (!probeConnected) {
      console.warn(
        `[P=${cfg.P} N=${cfg.N}] probe was disconnected by the end; Achieved/s is fan-out work, not delivered rows`,
      );
    }

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
      droppedTotalRate: Math.round(droppedTotalRate),
      aggCpuCores:
        cpuStart < 0 || cpuEnd < 0 || elapsedSec <= 0
          ? -1
          : (cpuEnd - cpuStart) / elapsedSec,
      probeMbPerSec:
        elapsedSec > 0 ? probeBytes / 1024 / 1024 / elapsedSec : 0,
      probeConnected,
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

/**
 * User + system CPU seconds of every process in group `pgid` (the
 * aggregator is spawned detached, so tsx and the node it starts share
 * one group). -1 without `/proc`.
 */
function groupCpuSec(pgid: number): number {
  let ticks = 0;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue; // exited meanwhile
      }
      // Fields after the ")" that closes the command name: state ppid
      // pgrp ... utime (14th field overall) stime (15th).
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) !== pgid) continue;
      ticks += Number(f[11]) + Number(f[12]);
    }
  } catch {
    return -1;
  }
  return ticks / 100; // USER_HZ is 100 on Linux
}

type ProducerMetrics = { uptimeSec: number; droppedRows: number };

async function fetchProducerMetrics(port: number): Promise<ProducerMetrics> {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!r.ok) throw new Error(`producer /metrics returned ${r.status}`);
  return (await r.json()) as ProducerMetrics;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TABLE_HEADER = [
  '| P | N | Target/s | Achieved/s | Dropped/s | Agg CPU cores | e2e p99 ms | pushMany p99 | fanout record p99 | fanout serialize p99 | fanout send p99 | GC major | GC minor | Heap peak | Avg batch | Residual | Probe MB/s |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function formatRow(r: Result): string {
  const num = (n: number): string => n.toLocaleString('en-US');
  return [
    `| ${r.P}`,
    `${r.N}`,
    num(r.targetTotalRate),
    num(r.achievedTotalRate),
    r.droppedTotalRate < 0 ? 'n/a' : num(r.droppedTotalRate),
    r.aggCpuCores < 0 ? 'n/a' : r.aggCpuCores.toFixed(2),
    r.latencyP99.toFixed(2),
    r.pushManyTotalP99.toFixed(2),
    r.fanoutRecordP99.toFixed(2),
    r.fanoutSerializeP99.toFixed(2),
    r.fanoutBroadcastP99.toFixed(2),
    `${r.gcMajorCount} / ${r.gcMajorTotalMs.toFixed(0)}ms`,
    `${r.gcMinorCount} / ${r.gcMinorTotalMs.toFixed(0)}ms`,
    `${r.heapPeakMb} MB`,
    r.pushManyAvgBatch.toFixed(1),
    `${r.arrivalQueueResidual}`,
    `${r.probeMbPerSec.toFixed(1)}${r.probeConnected ? '' : ' (DISCONNECTED)'} |`,
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
          droppedTotalRate: -1,
          probeMbPerSec: 0,
          aggCpuCores: -1,
          probeConnected: false,
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
