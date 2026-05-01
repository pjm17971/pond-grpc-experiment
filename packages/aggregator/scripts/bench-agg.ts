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
  type AppendMsg,
  type WireMsg,
} from '@pond-experiment/shared';
import type { MetricsSnapshot } from '../src/metrics.js';

/**
 * M3.5 aggregate-stream load test. Spins up producer + aggregator,
 * connects one WS probe to `/live` and one to `/live-agg`, runs at
 * the given (P × N) for `seconds`, then prints a side-by-side
 * report:
 *
 *   - raw firehose: append frames/sec, raw rows/sec
 *   - aggregate stream: tick frames/sec, raw events folded in
 *     (sum of cpu_n), fan-in ratio (raw/frame), tick inter-arrival
 *     median/p99 (200ms target), hosts covered per frame, sd of
 *     synchronized-clock alignment
 *   - aggregator-side: latency p99, heap peak, GC pressure
 *
 * The point isn't to push to saturation (`bench:full` already does
 * that for the raw wire). It's to verify the aggregate listener
 * doesn't choke at moderate-to-high rates, and that the 200ms tick
 * clock holds under the additional listener pressure.
 *
 *   pnpm bench:agg                         # default P=100 N=100, 30s
 *   pnpm bench:agg --P=100 --N=1000        # 100k events/sec
 *   pnpm bench:agg --P=100 --N=100 --seconds=60
 */

type Args = {
  P: number;
  N: number;
  seconds: number;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (k: string): string | undefined => {
    const prefix = `--${k}=`;
    return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };
  return {
    P: Number(get('P') ?? '100'),
    N: Number(get('N') ?? '100'),
    seconds: Number(get('seconds') ?? '30'),
  };
}

async function fetchMetrics(port: number): Promise<MetricsSnapshot> {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!r.ok) throw new Error(`/metrics returned ${r.status}`);
  return (await r.json()) as MetricsSnapshot;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pct(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetRate = args.P * args.N;
  console.log(
    `bench:agg — P=${args.P}, N=${args.N}, target=${targetRate.toLocaleString()}/s, duration=${args.seconds}s`,
  );

  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;
  let rawProbe: WebSocket | undefined;
  let aggProbe: WebSocket | undefined;

  // Raw firehose accumulators
  let rawAppendFrames = 0;
  let rawRows = 0;
  let rawSnapshots = 0;
  // Aggregate-stream accumulators
  let aggAppendFrames = 0;
  let aggSnapshots = 0;
  let aggRawEvents = 0; // sum of cpu_n across all rows of all frames
  const aggFrameTimes: number[] = []; // wall-clock arrival per agg-append
  const aggTickClockTs: number[] = []; // `ts` field per agg-append
  const aggHostsPerFrame: number[] = []; // rows.length per agg-append

  try {
    producer = await spawnProducer({
      grpcPort,
      eventsPerSec: args.N,
      hostCount: args.P,
    });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
    });

    rawProbe = new WebSocket(`ws://127.0.0.1:${httpPort}/live`);
    aggProbe = new WebSocket(`ws://127.0.0.1:${httpPort}/live-agg`);
    await Promise.all([
      new Promise<void>((res, rej) => {
        rawProbe!.on('open', () => res());
        rawProbe!.on('error', rej);
      }),
      new Promise<void>((res, rej) => {
        aggProbe!.on('open', () => res());
        aggProbe!.on('error', rej);
      }),
    ]);

    rawProbe.on('message', (data) => {
      const msg = decode(data.toString()) as WireMsg;
      if (msg.type === 'snapshot') rawSnapshots += 1;
      else if (msg.type === 'append') {
        rawAppendFrames += 1;
        rawRows += (msg as AppendMsg).rows.length;
      }
    });
    aggProbe.on('message', (data) => {
      const msg = decode(data.toString()) as WireMsg;
      if (msg.type === 'aggregate-snapshot') aggSnapshots += 1;
      else if (msg.type === 'aggregate-append') {
        const f = msg as AggregateAppendMsg;
        aggAppendFrames += 1;
        aggFrameTimes.push(performance.now());
        if (f.rows.length > 0) aggTickClockTs.push(f.rows[0].ts);
        aggHostsPerFrame.push(f.rows.length);
        for (const r of f.rows) aggRawEvents += r.cpu_n;
      }
    });

    // Warmup so streams settle (gRPC stream open, first batches drain,
    // /live-agg's first tick on the boundary).
    await sleep(5_000);

    // Reset accumulators after warmup so the report measures the
    // steady-state window.
    rawAppendFrames = 0;
    rawRows = 0;
    aggAppendFrames = 0;
    aggRawEvents = 0;
    aggFrameTimes.length = 0;
    aggTickClockTs.length = 0;
    aggHostsPerFrame.length = 0;

    const startedAt = performance.now();
    const baseline = await fetchMetrics(httpPort);
    await sleep(args.seconds * 1000);
    const final = await fetchMetrics(httpPort);
    const elapsedSec = (performance.now() - startedAt) / 1000;

    // ── Compute derived stats ──────────────────────────────────
    const rawFramesPerSec = rawAppendFrames / elapsedSec;
    const rawRowsPerSec = rawRows / elapsedSec;
    const aggFramesPerSec = aggAppendFrames / elapsedSec;
    const aggRawEventsPerSec = aggRawEvents / elapsedSec;
    const fanInRaw =
      aggAppendFrames === 0 ? 0 : aggRawEvents / aggAppendFrames;

    const interArrivals: number[] = [];
    for (let i = 1; i < aggFrameTimes.length; i++) {
      interArrivals.push(aggFrameTimes[i] - aggFrameTimes[i - 1]);
    }
    interArrivals.sort((a, b) => a - b);
    const interMedian = pct(interArrivals, 0.5);
    const interP99 = pct(interArrivals, 0.99);

    const tickGapsMs: number[] = [];
    for (let i = 1; i < aggTickClockTs.length; i++) {
      tickGapsMs.push(aggTickClockTs[i] - aggTickClockTs[i - 1]);
    }
    tickGapsMs.sort((a, b) => a - b);
    const tickGapMedian = pct(tickGapsMs, 0.5);
    const tickGapP99 = pct(tickGapsMs, 0.99);

    aggHostsPerFrame.sort((a, b) => a - b);
    const hostsP50 = pct(aggHostsPerFrame, 0.5);
    const hostsP99 = pct(aggHostsPerFrame, 0.99);

    const lat = final.latency.ingestToFanoutMs;
    const heapPeakMb = Math.round(final.memory.heapUsed / 1024 / 1024);
    const gcMajor = final.gc.major ?? { count: 0, totalMs: 0, maxMs: 0 };
    const gcMinor = final.gc.minor ?? { count: 0, totalMs: 0, maxMs: 0 };
    const gcMajorD = {
      count: gcMajor.count - (baseline.gc.major?.count ?? 0),
      totalMs: gcMajor.totalMs - (baseline.gc.major?.totalMs ?? 0),
    };
    const gcMinorD = {
      count: gcMinor.count - (baseline.gc.minor?.count ?? 0),
      totalMs: gcMinor.totalMs - (baseline.gc.minor?.totalMs ?? 0),
    };

    // ── Print report ───────────────────────────────────────────
    const num = (n: number): string => n.toLocaleString('en-US');
    console.log('');
    console.log(`Target rate ............ ${num(targetRate)}/s`);
    console.log(`Measured window ........ ${args.seconds}s`);
    console.log('');
    console.log('── /live (raw firehose) ─────────────────');
    console.log(
      `Append frames/sec ...... ${num(Math.round(rawFramesPerSec))}` +
        `   (snapshots: ${rawSnapshots})`,
    );
    console.log(`Raw rows/sec ........... ${num(Math.round(rawRowsPerSec))}`);
    console.log('');
    console.log('── /live-agg (aggregate stream) ─────────');
    console.log(
      `Tick frames/sec ........ ${aggFramesPerSec.toFixed(2)}` +
        `   (snapshots: ${aggSnapshots}, target 5.0/s @ 200ms)`,
    );
    console.log(
      `Inter-arrival ms ....... median ${interMedian.toFixed(1)}, p99 ${interP99.toFixed(1)} (target ~200)`,
    );
    console.log(
      `Tick-clock gap ms ...... median ${tickGapMedian.toFixed(0)}, p99 ${tickGapP99.toFixed(0)} (synchronized clock; gaps >200 = missed ticks)`,
    );
    console.log(
      `Hosts per frame ........ p50 ${hostsP50}, p99 ${hostsP99}` +
        `   (target ~${args.P} once warm)`,
    );
    console.log(`Raw events folded in ... ${num(Math.round(aggRawEventsPerSec))}/s`);
    console.log(`Fan-in (raw/frame) ..... ${fanInRaw.toFixed(1)}`);
    console.log('');
    console.log('── Aggregator pressure ──────────────────');
    if (lat) {
      console.log(
        `e2e latency ms ......... p50 ${lat.p50.toFixed(2)}, p95 ${lat.p95.toFixed(2)}, p99 ${lat.p99.toFixed(2)}`,
      );
    }
    console.log(
      `Heap peak .............. ${heapPeakMb} MB` +
        `   (rss ${Math.round(final.memory.rss / 1024 / 1024)} MB)`,
    );
    console.log(
      `GC major ............... ${gcMajorD.count} pauses / ${gcMajorD.totalMs.toFixed(0)}ms total`,
    );
    console.log(
      `GC minor ............... ${gcMinorD.count} pauses / ${gcMinorD.totalMs.toFixed(0)}ms total` +
        `   (${((gcMinorD.totalMs / (args.seconds * 1000)) * 100).toFixed(1)}% wall-clock)`,
    );
    console.log('');

    // Sanity: aggregate fan-in × frames/sec should ≈ raw rows/sec.
    // If not, the aggregate listener is dropping events somewhere.
    const fanInTotalPerSec = fanInRaw * aggFramesPerSec;
    const drift =
      rawRowsPerSec === 0 ? 0 : (fanInTotalPerSec / rawRowsPerSec) * 100 - 100;
    console.log(
      `Sanity: fan-in × frames/sec = ${num(Math.round(fanInTotalPerSec))}/s vs raw rows/sec ${num(Math.round(rawRowsPerSec))}/s (${drift.toFixed(1)}% drift)`,
    );
  } finally {
    rawProbe?.close();
    aggProbe?.close();
    if (aggregator) await aggregator.stop('SIGTERM');
    if (producer) await producer.stop('SIGTERM');
  }
}

await main();
