import {
  type PerformanceEntry,
  PerformanceObserver,
  constants as perfConstants,
  performance,
} from 'node:perf_hooks';

/** GC entries carry a `detail.kind` not surfaced on the base type. */
type GcEntry = PerformanceEntry & {
  detail?: { kind?: number };
};

/**
 * Latency histogram. Bounded ring; sort-on-read for percentile reads
 * since metrics are scraped at 1Hz, not per event. Sufficient at M3
 * stress rates (~500k events/s × 1024 sample buffer = ~2ms of data,
 * which is fine for a steady-state percentile snapshot).
 */
const HIST_CAPACITY = 1024;

class Histogram {
  private buf: number[] = [];
  private idx = 0;
  private filled = false;

  add(value: number): void {
    if (this.filled) {
      this.buf[this.idx] = value;
      this.idx = (this.idx + 1) % HIST_CAPACITY;
    } else {
      this.buf.push(value);
      if (this.buf.length === HIST_CAPACITY) this.filled = true;
    }
  }

  snapshot(): { p50: number; p95: number; p99: number; count: number } | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].sort((a, b) => a - b);
    return {
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      p99: pct(sorted, 0.99),
      count: sorted.length,
    };
  }
}

function pct(sorted: ReadonlyArray<number>, p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

// ── State ───────────────────────────────────────────────────────
const ingestToFanout = new Histogram();
/** Wall-clock ms `live.pushMany(rows)` took, per call (includes pond's synchronous batch listener fire). */
const pushManyTotalMs = new Histogram();
/** Wall-clock ms spent in fanout's `recordFanout` loop, per pond batch. */
const fanoutRecordMs = new Histogram();
/** Wall-clock ms spent in `events.map(toJsonRow)` + `JSON.stringify`, per pond batch. */
const fanoutSerializeMs = new Histogram();
/** Wall-clock ms spent in the WS broadcast loop (per-client `ws.send`), per pond batch. */
const fanoutBroadcastMs = new Histogram();
/**
 * Per-key FIFO queue of arrival timestamps. Keyed by `host:timeMs`,
 * which is NOT unique — at high producer rates `setInterval` can
 * fire twice within the same wall-clock ms, so the same `(host,
 * timeMs)` shows up multiple times. Storing arrivals as a list and
 * pairing FIFO on fanout matches the in-order processing of pond's
 * batch listener.
 */
const arrivalTimes = new Map<string, number[]>();
let eventsIngested = 0;
let eventsFannedOut = 0;
let bytesFannedOut = 0;
let pushManyCalls = 0;
let pushManyEventsTotal = 0;
let pushManyBatchSizeMax = 0;

// ── GC observer ─────────────────────────────────────────────────
const GC_KIND_NAMES: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

type GcBucket = { count: number; totalMs: number; maxMs: number };
const gcByKind: Record<string, GcBucket> = Object.create(null);

let gcObserver: PerformanceObserver | null = null;

/**
 * Subscribe to perf_hooks GC events. Returns a stop() to disconnect.
 * Idempotent — subsequent calls without a stop in between are no-ops.
 */
export function startGcObserver(): () => void {
  if (gcObserver) return () => {};
  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as GcEntry[]) {
      const kind = entry.detail?.kind ?? 0;
      const name = GC_KIND_NAMES[kind] ?? `unknown-${kind}`;
      const bucket =
        gcByKind[name] ?? { count: 0, totalMs: 0, maxMs: 0 };
      bucket.count += 1;
      bucket.totalMs += entry.duration;
      if (entry.duration > bucket.maxMs) bucket.maxMs = entry.duration;
      gcByKind[name] = bucket;
    }
  });
  gcObserver.observe({ entryTypes: ['gc'], buffered: false });
  return () => {
    gcObserver?.disconnect();
    gcObserver = null;
  };
}

// ── Recording APIs ──────────────────────────────────────────────
/**
 * Called from ingest at gRPC arrival. Appends the wall-clock arrival
 * to the per-key queue for later latency calculation.
 */
export function recordIngest(host: string, timeMs: number): void {
  const key = `${host}:${timeMs}`;
  const list = arrivalTimes.get(key);
  const t = performance.now();
  if (list) list.push(t);
  else arrivalTimes.set(key, [t]);
  eventsIngested += 1;
}

/**
 * Called from fanout once per event when its batch is about to be
 * broadcast. Pulls the front of the per-key queue and records the
 * ingest→fanout latency. Pairs FIFO so collisions
 * (multiple same-`(host, timeMs)` events from the same producer
 * tick) get matched in arrival order.
 */
export function recordFanout(host: string, timeMs: number): void {
  const key = `${host}:${timeMs}`;
  const list = arrivalTimes.get(key);
  if (list && list.length > 0) {
    const t0 = list.shift()!;
    ingestToFanout.add(performance.now() - t0);
    if (list.length === 0) arrivalTimes.delete(key);
  }
  eventsFannedOut += 1;
}

/**
 * Called per WS frame after `ws.send`. Pass total bytes pushed onto
 * the wire across all clients (i.e., `frame.length * clientCount`).
 */
export function recordBytesSent(totalBytes: number): void {
  bytesFannedOut += totalBytes;
}

/**
 * Called once per `live.pushMany(rows)` invocation in `ingest.ts`.
 * Tracks batch sizes (how many events per call) and per-phase
 * durations. `total` is the wall-clock from before pushMany to
 * after it returns — includes pond's synchronous batch listener
 * fire and everything inside it.
 */
export function recordPushMany(batchSize: number, totalMs: number): void {
  pushManyCalls += 1;
  pushManyEventsTotal += batchSize;
  if (batchSize > pushManyBatchSizeMax) pushManyBatchSizeMax = batchSize;
  pushManyTotalMs.add(totalMs);
}

/**
 * Called once per pond `'batch'` listener fire (inside `fanout.ts`).
 * Records how the listener's wall-clock budget breaks down across
 * the recordFanout loop, JSON serialization, and WS broadcast.
 *
 * Subtracting `recordMs + serializeMs + broadcastMs` from the
 * matching `pushManyTotalMs` sample gives "pond-only pushMany cost"
 * (validation + insertion + listener dispatch overhead).
 */
export function recordFanoutPhases(args: {
  recordMs: number;
  serializeMs: number;
  broadcastMs: number;
}): void {
  fanoutRecordMs.add(args.recordMs);
  fanoutSerializeMs.add(args.serializeMs);
  fanoutBroadcastMs.add(args.broadcastMs);
}

// ── Snapshot ────────────────────────────────────────────────────
export type MetricsSnapshot = {
  uptimeSec: number;
  events: {
    ingested: number;
    fannedOut: number;
    bytesFannedOut: number;
  };
  /** Macrotask-coalesced pushMany batching stats (phase-5 measurement). */
  pushMany: {
    calls: number;
    totalEvents: number;
    /** Total events / total calls. NaN if calls === 0. */
    avgBatchSize: number;
    maxBatchSize: number;
  };
  liveSeriesLength: number;
  /** Events seen by ingest but not yet by fanout — heap pressure proxy. */
  arrivalQueueLength: number;
  latency: {
    ingestToFanoutMs:
      | { p50: number; p95: number; p99: number; count: number }
      | null;
    /** Per-pushMany-call total, includes pond's synchronous batch listener. */
    pushManyTotalMs:
      | { p50: number; p95: number; p99: number; count: number }
      | null;
    /** Per-batch wall-clock in the fanout's `recordFanout` loop. */
    fanoutRecordMs:
      | { p50: number; p95: number; p99: number; count: number }
      | null;
    /** Per-batch wall-clock in `events.map(toJsonRow)` + `JSON.stringify`. */
    fanoutSerializeMs:
      | { p50: number; p95: number; p99: number; count: number }
      | null;
    /** Per-batch wall-clock in the WS broadcast loop (per-client `ws.send`). */
    fanoutBroadcastMs:
      | { p50: number; p95: number; p99: number; count: number }
      | null;
  };
  ws: {
    clientCount: number;
    /** Per-connected-client outbound buffer. */
    bufferedAmount: ReadonlyArray<number>;
  };
  memory: NodeJS.MemoryUsage;
  /** GC pauses bucketed by kind ('major', 'minor', 'incremental', 'weakcb'). */
  gc: Record<string, GcBucket>;
};

function countArrivalEntries(): number {
  let total = 0;
  for (const list of arrivalTimes.values()) total += list.length;
  return total;
}

export function snapshot(args: {
  liveSeriesLength: number;
  wsClientBufferedAmounts: ReadonlyArray<number>;
}): MetricsSnapshot {
  return {
    uptimeSec: process.uptime(),
    events: {
      ingested: eventsIngested,
      fannedOut: eventsFannedOut,
      bytesFannedOut,
    },
    pushMany: {
      calls: pushManyCalls,
      totalEvents: pushManyEventsTotal,
      avgBatchSize:
        pushManyCalls === 0 ? NaN : pushManyEventsTotal / pushManyCalls,
      maxBatchSize: pushManyBatchSizeMax,
    },
    liveSeriesLength: args.liveSeriesLength,
    arrivalQueueLength: countArrivalEntries(),
    latency: {
      ingestToFanoutMs: ingestToFanout.snapshot(),
      pushManyTotalMs: pushManyTotalMs.snapshot(),
      fanoutRecordMs: fanoutRecordMs.snapshot(),
      fanoutSerializeMs: fanoutSerializeMs.snapshot(),
      fanoutBroadcastMs: fanoutBroadcastMs.snapshot(),
    },
    ws: {
      clientCount: args.wsClientBufferedAmounts.length,
      bufferedAmount: args.wsClientBufferedAmounts,
    },
    memory: process.memoryUsage(),
    gc: { ...gcByKind },
  };
}
