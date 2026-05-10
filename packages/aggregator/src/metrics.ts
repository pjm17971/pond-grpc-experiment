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
/**
 * Lateness reservoir for the milestone-B late-data driver. Stores
 * `highWater - event.timeMs` (ms behind the highest event timestamp
 * seen so far at ingest) for every event flagged as late. Same
 * circular-reservoir shape as `Histogram` so percentile reads are
 * O(samples log samples) on the read side, O(1) on the write side.
 */
const latenessMs = new Histogram();
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
/**
 * Hard cap on `arrivalTimes` Map size. V8's `Map` ceiling is ~16M
 * entries; without a cap, the aggregator at firehose × no-/live-
 * subscribers (post-step-9 dashboard) accumulates entries because
 * `recordIngest` is upstream of any fanout / sample filter while
 * `recordFanout` only fires when a /live client is broadcasting.
 * Drop ingest entries beyond this cap — latency-percentile stats
 * become incomplete but the aggregator stays alive.
 */
const ARRIVAL_TIMES_MAX_KEYS = 200_000;
let arrivalTimesDropped = 0;
let eventsIngested = 0;
let eventsFannedOut = 0;
let bytesFannedOut = 0;
let pushManyCalls = 0;
let pushManyEventsTotal = 0;
let pushManyBatchSizeMax = 0;

/**
 * Late-event correctness instrumentation for milestone-B's late-data
 * driver. Counters grow at ingest as events arrive; each is keyed
 * off the relationship between the event's `timeMs` and the highest
 * `timeMs` seen so far (`highWaterTs`).
 *
 * Definitions (the brief at `pond-ts/docs/briefs/grpc-late-data-validation.md`
 * uses these terms; restated here for the readers of `/metrics`):
 *
 * - **late at ingest** — `event.timeMs < highWaterTs`. Strictly out
 *   of order; under pond `'strict'` mode this would throw.
 * - **late within baseline** — late at ingest AND
 *   `event.timeMs >= highWaterTs - baselineWindowMs`. The event
 *   falls inside the rolling baseline window's logical span, so a
 *   correct late-repair semantic would have to retroactively shift
 *   the rolling's `cpu_avg`/`cpu_sd` for those windows. Pond's
 *   rolling does NOT repair these (the milestone-B gap).
 * - **late past baseline** — late at ingest AND
 *   `event.timeMs < highWaterTs - baselineWindowMs`. Outside the
 *   rolling's logical window — even a correct repair semantic would
 *   leave the rolling untouched (the event's bucket was already
 *   evicted from the window). Counts here characterise tail
 *   workloads where the producer's late distribution leaks past 60s.
 * - **late past grace** — late at ingest AND
 *   `event.timeMs < highWaterTs - graceWindowMs`. Pond rejects these
 *   at ingest under `'drop'`/`'reorder'`; under `'strict'` they
 *   throw. Surfaced separately so the snapshot shows how much of
 *   the producer's tail makes it past the configured grace window.
 *
 * Per-host counts are kept for the friction note's host-bias
 * workload analysis (do biased late events show up disproportionately
 * on the biased host vs. uniformly across the pool). Capped to
 * `LATE_BY_HOST_MAX_KEYS` to bound memory at runtime.
 */
let lateBaselineWindowMs = 60_000;
let lateGraceWindowMs = 30_000;
let highWaterTs: number | null = null;
let eventsLateAtIngestTotal = 0;
let eventsLateWithinBaselineTotal = 0;
let eventsLatePastBaselineTotal = 0;
let eventsLatePastGraceTotal = 0;
const LATE_BY_HOST_MAX_KEYS = 1_000;
const lateWithinBaselineByHost = new Map<string, number>();
let lateByHostDropped = 0;

/**
 * Pond throws from `#insert` under two paths the experiment cares
 * about:
 *
 * - `ordering: 'strict'` + an out-of-order event → throws (regardless
 *   of `graceWindow`, which only applies under `'reorder'`).
 * - `ordering: 'reorder'` + an event past `graceWindow` → throws.
 *
 * `'drop'` silently rejects (counted by pond's own `#statsRejected`,
 * surfaced via `live.stats().rejected`). Strict / reorder are the
 * "loud" cases — `pushMany` is non-atomic, so a throw mid-batch
 * kills the rest of the batch. The aggregator's ingest path catches
 * these and falls back to per-row push so a single past-grace event
 * doesn't strand the on-time events behind it. This counter tracks
 * the per-row recovery hits — read alongside `live.stats().rejected`
 * for the full picture under `'drop'`/`'reorder'`/`'strict'`.
 */
let pondInsertThrowsTotal = 0;

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
  const t = performance.now();
  const key = `${host}:${timeMs}`;
  const list = arrivalTimes.get(key);
  if (list) {
    list.push(t);
  } else if (arrivalTimes.size < ARRIVAL_TIMES_MAX_KEYS) {
    arrivalTimes.set(key, [t]);
  } else {
    // Cap reached — drop the entry. Latency pairing for this
    // event won't happen, but the aggregator survives.
    arrivalTimesDropped += 1;
  }
  eventsIngested += 1;
}

/**
 * Configure the late-event detection thresholds. Called once on
 * aggregator startup with the values used to construct the
 * `LiveSeries` (the rolling baseline length is fixed at 60s today
 * by `aggregate.ts`'s fused-rolling spec; if that ever becomes
 * configurable, plumb the new value here too).
 *
 * Calling without a stop is fine — replaces the current values.
 * Resetting the counters intentionally NOT done here: snapshot
 * consumers want cumulative values across the process lifetime, and
 * a misconfiguration shouldn't silently zero them.
 */
export function configureLateness(opts: {
  baselineWindowMs: number;
  graceWindowMs: number;
}): void {
  lateBaselineWindowMs = opts.baselineWindowMs;
  lateGraceWindowMs = opts.graceWindowMs;
}

/**
 * Called from ingest once per event, after `recordIngest`. Updates
 * the high-water mark and (for events that arrive late) increments
 * the matching counters and lateness reservoir.
 *
 * Cheap O(1). Per-host counter bumped via Map; capped at
 * `LATE_BY_HOST_MAX_KEYS` (drops new keys past the cap rather than
 * unbounded growth at long-running pipelines with churning host sets).
 */
export function recordLatenessOnIngest(
  host: string,
  eventTimeMs: number,
): void {
  if (highWaterTs === null) {
    highWaterTs = eventTimeMs;
    return;
  }
  if (eventTimeMs >= highWaterTs) {
    highWaterTs = eventTimeMs;
    return;
  }
  // Event is late: timeMs < highWater.
  const lagMs = highWaterTs - eventTimeMs;
  eventsLateAtIngestTotal += 1;
  latenessMs.add(lagMs);
  if (lagMs > lateGraceWindowMs) {
    eventsLatePastGraceTotal += 1;
  }
  if (lagMs <= lateBaselineWindowMs) {
    eventsLateWithinBaselineTotal += 1;
    const prev = lateWithinBaselineByHost.get(host);
    if (prev !== undefined) {
      lateWithinBaselineByHost.set(host, prev + 1);
    } else if (lateWithinBaselineByHost.size < LATE_BY_HOST_MAX_KEYS) {
      lateWithinBaselineByHost.set(host, 1);
    } else {
      lateByHostDropped += 1;
    }
  } else {
    eventsLatePastBaselineTotal += 1;
  }
}

/**
 * Called from ingest when `live.pushMany` (or a per-row fallback
 * `live.push`) throws. Counts the rejection so the friction-note
 * harness can characterise how often pond rejects events under the
 * configured `ordering` + `graceWindow`. Cheap O(1).
 */
export function recordPondInsertThrow(): void {
  pondInsertThrowsTotal += 1;
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

/**
 * Snapshot of pond's `live.stats()` plus the experiment-side
 * late-event counters. Surfaced separately from `events` /
 * `latency` so the friction-note bench harness can scrape it
 * directly without parsing arbitrary wire shapes.
 */
export type LatenessSnapshot = {
  /** Pond's internal counters — `ingested`, `evicted`, `rejected`. */
  liveStats: {
    ingested: number;
    evicted: number;
    rejected: number;
    length: number;
    earliestTs?: number;
    latestTs?: number;
  };
  /** Highest `timeMs` ever observed at ingest. Null before first event. */
  highWaterTs: number | null;
  /** Configured baseline-window length used by the late-classifier (ms). */
  baselineWindowMs: number;
  /** Configured grace-window length used by the late-classifier (ms). */
  graceWindowMs: number;
  /** Total events whose `timeMs` was < `highWaterTs` at arrival. */
  eventsLateAtIngestTotal: number;
  /**
   * Of `eventsLateAtIngestTotal`: events whose `timeMs` falls inside
   * the baseline window. Pond's rolling does not retroactively
   * repair these — milestone B's payoff scenario.
   */
  eventsLateWithinBaselineTotal: number;
  /**
   * Of `eventsLateAtIngestTotal`: events whose `timeMs` falls past
   * the baseline window's start (60s back). Even a correct repair
   * semantic wouldn't change the rolling for these — bucket already
   * evicted from the window's logical span.
   */
  eventsLatePastBaselineTotal: number;
  /**
   * Of `eventsLateAtIngestTotal`: events whose `timeMs` falls past
   * the configured grace window. Under `'drop'`/`'reorder'` pond
   * rejects these at ingest; under `'strict'` they throw. Surfaced
   * separately so the snapshot shows the producer's lateness tail
   * shape relative to grace.
   */
  eventsLatePastGraceTotal: number;
  /** Reservoir-derived percentile reads of lag (highWater - timeMs), ms. */
  latencyBehindHighWaterMs:
    | { p50: number; p95: number; p99: number; count: number }
    | null;
  /**
   * Per-host count of `lateWithinBaseline` events. Drives the
   * host-bias drift analysis in the friction note (do biased late
   * events land on the biased host or scatter). Capped at
   * `LATE_BY_HOST_MAX_KEYS` keys.
   */
  lateWithinBaselineByHost: Record<string, number>;
  /** Late events whose host couldn't be tracked (cap reached). */
  lateByHostDropped: number;
  /**
   * Cumulative count of `live.pushMany` / `live.push` calls that
   * threw from pond's `#insert`. Under `'strict'` mode these are
   * out-of-order events; under `'reorder'`, past-grace events.
   * Drop mode never throws (those land in `liveStats.rejected`).
   */
  pondInsertThrowsTotal: number;
};

export type MetricsSnapshot = {
  uptimeSec: number;
  events: {
    ingested: number;
    fannedOut: number;
    bytesFannedOut: number;
  };
  /**
   * Late-event correctness section. See `LatenessSnapshot` for the
   * exact shape and the per-counter definitions. Empty / zeroed
   * fields are normal under workloads with no late events
   * (`LATE_EVENT_FRACTION=0` on the producer).
   */
  late: LatenessSnapshot;
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
  /**
   * Ingest events dropped from the latency-pairing Map because the
   * cap (`ARRIVAL_TIMES_MAX_KEYS`) was reached. Indicates the
   * dashboard isn't subscribing to /live (no fanout to drain) and
   * the latency stats below are computed from a sample. Survival
   * gauge: as long as this stays at or below the cap, the
   * aggregator won't OOM the V8 Map ceiling.
   */
  arrivalTimesDropped: number;
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
  /**
   * Pond's `live.stats()` snapshot. Server.ts owns the `LiveSeries`
   * reference; we don't (deliberately, so this module stays free of
   * pond imports for ease of test fixture wiring).
   */
  liveStats: {
    ingested: number;
    evicted: number;
    rejected: number;
    length: number;
    earliestTs?: number;
    latestTs?: number;
  };
}): MetricsSnapshot {
  return {
    uptimeSec: process.uptime(),
    events: {
      ingested: eventsIngested,
      fannedOut: eventsFannedOut,
      bytesFannedOut,
    },
    late: {
      liveStats: args.liveStats,
      highWaterTs,
      baselineWindowMs: lateBaselineWindowMs,
      graceWindowMs: lateGraceWindowMs,
      eventsLateAtIngestTotal,
      eventsLateWithinBaselineTotal,
      eventsLatePastBaselineTotal,
      eventsLatePastGraceTotal,
      latencyBehindHighWaterMs: latenessMs.snapshot(),
      lateWithinBaselineByHost: Object.fromEntries(lateWithinBaselineByHost),
      lateByHostDropped,
      pondInsertThrowsTotal,
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
    arrivalTimesDropped,
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
