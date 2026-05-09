import {
  Sequence,
  Trigger,
  type LiveSeries,
  type LiveSource,
  type SeriesSchema,
  type EventForSchema,
} from 'pond-ts';
import {
  DEFAULT_AGGREGATE_THRESHOLDS,
  type AggregateAppendMsg,
  type GlobalsTick,
  type HostTick,
  type Schema,
  encode,
} from '@pond-experiment/shared';

/**
 * Server-side aggregate-stream emitter.
 *
 * Builds the per-host tick aggregates the `/live-agg` wire ships
 * (`HostTick`: `cpu_avg`/`cpu_sd`/`cpu_n`, `n_current`, anomaly
 * arrays, `requests_avg`/`requests_sum`/`requests_n`) by composing
 * **one fused multi-window partitioned rolling** (pond 0.15.0+)
 * clocked off `Trigger.clock(seq)`:
 *
 *   live.partitionBy('host').rolling(
 *     {
 *       '1m': {
 *         cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count',
 *         requests_avg: 'avg', requests_sum: 'sum', requests_n: 'count',
 *       },
 *       `${tickMs}ms`: { cpu_samples: 'samples' },
 *     },
 *     { trigger },
 *   );
 *
 * One per-event ingest pass updates every reducer's state in the
 * same partition object; one boundary check fires; one synchronised
 * burst emits a single merged event per partition per tick. Every
 * column the consumer cares about is on that one event.
 *
 * History:
 * - V6 (#16) — manual per-host deque off `live.on('batch', cb)` for
 *   the leading-edge slice; one pond rolling for baseline.
 * - V7 (#18) — pond 0.14.2 `samples()` reducer, two parallel
 *   rollings sharing one trigger. ~19% throughput regression at
 *   ceiling because every event flowed through two ingest pipelines
 *   (see PR #19's profile diff).
 * - V8 (#22) — pond 0.15.0 fused rolling. Two windows, one rolling,
 *   one ingest pass; recovers V6's per-event cost.
 * - Step 5 (this) — extends the 1m baseline with the requests stats;
 *   no shape change, just three more reducers in the same window.
 *   The fused-rolling primitive composes for additional source
 *   columns at near-zero per-event cost (the per-event ingest pass
 *   visits the same partition once and updates each reducer's
 *   running state in a tight loop).
 *
 * The pendingByTs collation below stays — pond emits one event per
 * partition per tick, and the wire ships one frame per tick across
 * all partitions. The collation merges the per-partition bursts
 * into a single `aggregate-append`.
 */
export type AggregateOptions = {
  /** Tick cadence in milliseconds. Default 200, matches `WIRE.md`. */
  tickMs?: number;
  /**
   * Anomaly-density σ thresholds. Defaults to
   * `DEFAULT_AGGREGATE_THRESHOLDS`. Length matches the
   * `anomalies_above`/`anomalies_below` arrays the wire ships.
   */
  thresholds?: ReadonlyArray<number>;
  /**
   * How much per-host tick history (in ms) to retain for the
   * snapshot-on-connect frame. Defaults to 5 minutes — matches the
   * dashboard's chart back-window so a connecting client sees the
   * chart already filled, not a blank canvas filling in over time.
   * Set to 0 to disable history (snapshot ships empty `rows` /
   * `globals`, the pre-step-8 behaviour).
   */
  historyMaxAgeMs?: number;
  /**
   * Per-host stride sample applied **between** `partitionBy('host')`
   * and the fused rolling — `live.partitionBy('host').sample({ stride
   * }).rolling(...)`. `1` (the default) is the no-op pass-through;
   * `N > 1` keeps every Nth event per host so the rolling baseline
   * sees N× fewer samples. The math works for `avg`/`stdev`/`count`
   * (standard error grows √N, stays well below per-event noise at
   * firehose); see `friction-notes/rfcs/bounded-memory-sampling.md`.
   *
   * Pre-0.17.0 the experiment ran a hand-rolled per-host stride
   * sampler at the gRPC ingest hop (in `ingest.ts`); 0.17.0 ships
   * the real `live.partitionBy(...).sample({ stride })` operator,
   * so the sampling lives in the pipeline now. The big wire-visible
   * difference: `live.on('batch', cb)` and the non-partitioned
   * globals rolling (`events_per_sec`) sit **upstream** of the
   * sample — they see the true firehose, so cumulative counters
   * (`events_ingested_total`, `requests_ingested_total`,
   * `events_per_sec`) reflect actual gRPC throughput regardless of
   * how aggressively the per-host baseline is thinned.
   */
  sampleStride?: number;
};

const DEFAULT_HISTORY_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Bounded ring of recent `HostTick`s + `GlobalsTick`s, populated as
 * the aggregator emits frames and consumed when a new client
 * connects to `/live-agg`. The ring is kept independent of the raw
 * `LiveSeries`'s retention because the two have different shapes
 * and lifetimes: the raw `live` only needs ~1m for the fused
 * rolling's longest window, but the dashboard wants ~5m of tick
 * history to draw a full back-window chart on connect.
 *
 * Eviction uses an amortised head-index pattern (à la pond 0.15.2's
 * `LiveFusedRolling.#compactFront`) so per-emit cost is O(1)
 * regardless of ring length.
 */
export type SnapshotHistory = {
  rows: ReadonlyArray<HostTick>;
  globals: ReadonlyArray<GlobalsTick>;
};

type BaselineParts = {
  cpu_avg: number | null;
  cpu_sd: number | null;
  cpu_n: number;
  requests_avg: number | null;
  requests_sum: number;
  requests_n: number;
  window_age_seconds: number;
  cpu_min: number | null;
  cpu_max: number | null;
};

export function startAggregate(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
  opts: AggregateOptions = {},
): {
  stop: () => void;
  /**
   * Snapshot history for the WS-on-connect frame. Returns the
   * currently-retained `HostTick`s and `GlobalsTick`s. Both arrays
   * are sorted by `ts`. Server.ts calls this when a `/live-agg`
   * client connects so the dashboard sees the chart's back-window
   * already filled instead of waiting ~5 minutes for it to fill in.
   */
  getSnapshotHistory: () => SnapshotHistory;
} {
  const tickMs = opts.tickMs ?? 200;
  const thresholds = opts.thresholds ?? DEFAULT_AGGREGATE_THRESHOLDS;
  const historyMaxAgeMs = opts.historyMaxAgeMs ?? DEFAULT_HISTORY_MAX_AGE_MS;
  const sampleStride = Math.max(1, Math.floor(opts.sampleStride ?? 1));
  const seq = Sequence.every(`${tickMs}ms`);
  const trigger = Trigger.clock(seq);

  // Single fused rolling — pond 0.15.0. The keyed-form mapping
  // declares two windows: a 1m baseline (avg/stdev/count) and a
  // `tickMs`-ms slice (samples). Output schema is the merge of
  // every window's columns; events fire on the shared trigger's
  // boundary with all columns populated. See pond-grpc-experiment#20
  // for the RFC.
  //
  // pond 0.15.1 captures the partition column name into the
  // `LivePartitionedSeries`'s `ByCol` generic from the `by`
  // argument, so the fused-rolling output schema's partition
  // column types as `ColumnDef<'host', 'string'>` without an
  // explicit type argument. (Pre-0.15.1 needed `partitionBy<'host'>(...)`.)
  //
  // **Sampling insertion (pond 0.17.0).** When `sampleStride > 1`,
  // a `.sample({ stride })` op sits between `partitionBy('host')`
  // and `.rolling(...)` so each host's stream is thinned 1-in-N
  // before flowing into the per-host rolling state. Counts +
  // listeners on `live` itself are unaffected (they're upstream of
  // the sample); only the rolling's per-partition deque sees the
  // thinned stream. `stride === 1` is the no-op pass-through —
  // skip the call so the hot path stays identical to pre-0.17 for
  // the unsampled deployment.
  const partitioned = live.partitionBy('host');
  const sampled =
    sampleStride > 1
      ? partitioned.sample({ stride: sampleStride })
      : partitioned;
  const fused: LiveSource<SeriesSchema> = sampled.rolling(
      {
        '1m': {
          cpu_avg: { from: 'cpu', using: 'avg' },
          cpu_sd: { from: 'cpu', using: 'stdev' },
          cpu_n: { from: 'cpu', using: 'count' },
          requests_avg: { from: 'requests', using: 'avg' },
          requests_sum: { from: 'requests', using: 'sum' },
          requests_n: { from: 'requests', using: 'count' },
        },
        [`${tickMs}ms`]: {
          cpu_samples: { from: 'cpu', using: 'samples' },
          // Step 7 — per-tick CPU extrema for the dashboard's "show
          // min/max envelope" overlay. Same window as `cpu_samples`,
          // built-in min/max reducers; both emit undefined for an
          // empty slice (defensively coerced to null in `assembleTick`).
          cpu_min: { from: 'cpu', using: 'min' },
          cpu_max: { from: 'cpu', using: 'max' },
        },
      },
      { trigger },
    );

  // Step 6 — globals: aggregator-wide stats emitted on the same
  // tick clock as the per-host fused rolling. `events_per_sec`
  // comes from a **non-partitioned fused rolling** clocked off the
  // same `Trigger.clock(seq)`; cumulative counters
  // (`events_ingested_total`, `evicted_total`, `firstEventTs` for
  // window-age) come from `live.on('batch'/'evict')` callbacks.
  //
  // **Note on the 0.15.0 → 0.15.2 evolution.** The first commit on
  // this branch tried `live.rolling({'1s': {events_per_sec:
  // 'count'}}, {trigger})` — the natural API — and saw throughput
  // collapse from 88k/s to 21k/s at the 87k/s bench point. Cause:
  // every raw event flowed through the non-partitioned rolling's
  // per-event ingest pipeline serially, plus an `Array.shift()` on
  // every eviction at the rolling's deque (O(N) per ingest at
  // firehose deque sizes). pond-ts 0.15.2 fixed the eviction loop
  // (head-index + amortised batched compaction; see CHANGELOG)
  // citing this PR's friction note directly. Re-enabled the
  // natural shape here.
  let eventsIngested = 0;
  let eventsEvicted = 0;
  // Step 9 — cumulative `requests`-column sum across every ingested
  // event. Drives the dashboard's "Total requests" headline after
  // /live retirement; previously the dashboard rolled it up itself
  // off the raw firehose, which was exactly the path the wire-side
  // aggregate redesign was supposed to eliminate. Same listener
  // shape as `eventsIngested`; pond's `Event.get('requests')` is
  // narrowed to `number` by the schema so no nullability handling
  // needed at the row level.
  let requestsIngested = 0;
  // `firstEventTs` — wall-clock of the first event the aggregator
  // ever sees. Used to compute `window_age_seconds` per emitted
  // tick. Once the rolling window has been full for >=60s, age
  // pins to 60; before then it's the actual elapsed-since-start.
  let firstEventTs: number | null = null;
  const offBatch = live.on('batch', (events) => {
    eventsIngested += events.length;
    for (const e of events) {
      requestsIngested += e.get('requests');
    }
    if (firstEventTs === null && events.length > 0) {
      firstEventTs = events[0].key().timestampMs();
    }
  });
  const offEvict = live.on('evict', (events) => {
    eventsEvicted += events.length;
  });

  /** 1m baseline window length in seconds (matches the fused mapping above). */
  const baselineWindowSec = 60;

  // Non-partitioned fused rolling for `events_per_sec`. Emits one
  // event per trigger boundary (5 fps at the default tickMs) with
  // the count of source events in the trailing 1s window. We snap
  // its output into `latestEventsPerSec` to attach to whatever
  // tick frame the per-host fused rolling drives next.
  const globalsStream: LiveSource<SeriesSchema> = live.rolling(
    {
      '1s': { events_per_sec: { from: 'cpu', using: 'count' } },
    },
    { trigger },
  );
  let latestEventsPerSec = 0;
  const offGlobals = globalsStream.on(
    'event',
    (e: EventForSchema<SeriesSchema>) => {
      const eps = e.get('events_per_sec');
      if (typeof eps === 'number') latestEventsPerSec = eps;
    },
  );

  // Per-`ts` row collation — pond fires one event per partition per
  // tick boundary; the wire ships one frame per tick across all
  // partitions. The microtask drain accumulates the per-partition
  // events for a given `ts` into a single `aggregate-append` frame
  // and emits it in monotonic order. Globals are computed at emit
  // time from the running counters (no separate buffer; see the
  // comment block above on why we don't run a parallel pond
  // pipeline for the rate).
  const pendingByTs = new Map<number, HostTick[]>();
  let lastEmittedTs = -1;
  let scheduled = false;

  // Snapshot-history rings. Per-emit, every row + the globals tick
  // get appended; eviction advances a head index (no `Array.shift`
  // hot path — same amortised-O(1) pattern pond 0.15.2 adopted on
  // its own deques). Periodic compaction reclaims the dead prefix
  // when it grows past half the array; consumers only see the live
  // tail via `getSnapshotHistory()`.
  const historyRows: HostTick[] = [];
  const historyGlobals: GlobalsTick[] = [];
  let historyRowsHead = 0;
  let historyGlobalsHead = 0;
  const historyDisabled = historyMaxAgeMs <= 0;
  const evictHistory = (cutoffTs: number): void => {
    if (historyDisabled) return;
    while (
      historyRowsHead < historyRows.length &&
      historyRows[historyRowsHead].ts < cutoffTs
    ) {
      historyRowsHead += 1;
    }
    if (historyRowsHead > historyRows.length / 2) {
      historyRows.splice(0, historyRowsHead);
      historyRowsHead = 0;
    }
    while (
      historyGlobalsHead < historyGlobals.length &&
      historyGlobals[historyGlobalsHead].ts < cutoffTs
    ) {
      historyGlobalsHead += 1;
    }
    if (historyGlobalsHead > historyGlobals.length / 2) {
      historyGlobals.splice(0, historyGlobalsHead);
      historyGlobalsHead = 0;
    }
  };

  const scheduleEmit = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      tryEmit();
    });
  };

  const tryEmit = (): void => {
    const tsList = [...pendingByTs.keys()].sort((a, b) => a - b);
    for (const ts of tsList) {
      if (ts <= lastEmittedTs) {
        pendingByTs.delete(ts);
        continue;
      }
      const rows = pendingByTs.get(ts);
      if (!rows || rows.length === 0) continue;
      lastEmittedTs = ts;

      // Globals — events_per_sec comes from the non-partitioned
      // 1s rolling above; cumulative counters from manual batch /
      // evict listeners. The rolling fires on every trigger
      // boundary, so `latestEventsPerSec` is at most one tick
      // (200ms) stale relative to this `ts`.
      const globals: GlobalsTick = {
        ts,
        events_ingested_total: eventsIngested,
        events_per_sec: Math.round(latestEventsPerSec),
        evicted_total: eventsEvicted,
        requests_ingested_total: requestsIngested,
      };

      const msg: AggregateAppendMsg = {
        type: 'aggregate-append',
        rows,
        globals,
      };
      broadcast(encode(msg));
      pendingByTs.delete(ts);

      // Mirror into the snapshot-history ring. Append-then-evict
      // (not evict-then-append) so a tick that's at the very edge
      // of the retention window still gets one emit slot before
      // sliding off — matches the WIRE.md "snapshot is the most
      // recent N ticks" semantic.
      if (!historyDisabled) {
        for (const row of rows) historyRows.push(row);
        historyGlobals.push(globals);
        evictHistory(ts - historyMaxAgeMs);
      }
    }
  };

  const offFused = fused.on(
    'event',
    (e: EventForSchema<SeriesSchema>) => {
      const ts = e.key().begin();
      const host = e.get('host');
      if (typeof host !== 'string') return;

      const cpu_avg = e.get('cpu_avg');
      const cpu_sd = e.get('cpu_sd');
      const cpu_n = e.get('cpu_n');
      const cpu_min = e.get('cpu_min');
      const cpu_max = e.get('cpu_max');
      const requests_avg = e.get('requests_avg');
      const requests_sum = e.get('requests_sum');
      const requests_n = e.get('requests_n');
      // `samples` reducer returns `ReadonlyArray<number> | undefined`
      // (undefined when the window is gated or empty). Normalise to
      // an empty array so anomaly counting sees a regular shape.
      const rawSamples = e.get('cpu_samples');
      const samples: ReadonlyArray<number> = Array.isArray(rawSamples)
        ? (rawSamples as ReadonlyArray<number>)
        : [];

      // Window-age clock for warmup correctness on rolling-rate
      // displays. `firstEventTs` is the wall-clock of the first
      // ingested event; the rolling 1m window covers
      // `min(60, ts - firstEventTs)` seconds at this tick. Same
      // value across hosts at the same `ts` (cluster-global), but
      // emitted per row so historical chart pipelines stay self-
      // describing without a cross-row join.
      const windowAgeSec =
        firstEventTs === null
          ? 0
          : Math.min(baselineWindowSec, (ts - firstEventTs) / 1000);

      const tick = assembleTick(
        ts,
        host,
        {
          cpu_avg: typeof cpu_avg === 'number' ? cpu_avg : null,
          cpu_sd: typeof cpu_sd === 'number' ? cpu_sd : null,
          cpu_n: typeof cpu_n === 'number' ? cpu_n : 0,
          requests_avg:
            typeof requests_avg === 'number' ? requests_avg : null,
          // `sum` of an empty bucket is 0, not undefined — defensive
          // coerce keeps the wire shape regular if pond ever changes
          // its empty-bucket policy.
          requests_sum:
            typeof requests_sum === 'number' ? requests_sum : 0,
          requests_n: typeof requests_n === 'number' ? requests_n : 0,
          window_age_seconds: windowAgeSec,
          cpu_min: typeof cpu_min === 'number' ? cpu_min : null,
          cpu_max: typeof cpu_max === 'number' ? cpu_max : null,
        },
        samples,
        thresholds,
      );

      let rows = pendingByTs.get(ts);
      if (!rows) {
        rows = [];
        pendingByTs.set(ts, rows);
      }
      rows.push(tick);
      scheduleEmit();
    },
  );

  return {
    stop: () => {
      offFused();
      offGlobals();
      offBatch();
      offEvict();
      pendingByTs.clear();
      historyRows.length = 0;
      historyGlobals.length = 0;
      historyRowsHead = 0;
      historyGlobalsHead = 0;
    },
    getSnapshotHistory: (): SnapshotHistory => ({
      rows: historyRows.slice(historyRowsHead),
      globals: historyGlobals.slice(historyGlobalsHead),
    }),
  };
}

/**
 * Compose a `HostTick` from the joined baseline stats + current-slice
 * raw samples, including the σ-bucketed anomaly-count arrays.
 *
 * Anomaly counting is gated on `cpu_avg`/`cpu_sd` being defined —
 * with no baseline to compare against, "anomalous" is undefined.
 * Returns zero-filled arrays in that case so the wire shape stays
 * regular (length always equals `thresholds.length`).
 */
function assembleTick(
  ts: number,
  host: string,
  baseline: BaselineParts,
  samples: ReadonlyArray<number>,
  thresholds: ReadonlyArray<number>,
): HostTick {
  const above = new Array<number>(thresholds.length).fill(0);
  const below = new Array<number>(thresholds.length).fill(0);
  const n_current = samples.length;

  if (
    baseline.cpu_avg != null &&
    baseline.cpu_sd != null &&
    n_current > 0
  ) {
    const mean = baseline.cpu_avg;
    const sd = baseline.cpu_sd;
    for (const v of samples) {
      const diff = v - mean;
      for (let i = 0; i < thresholds.length; i++) {
        const cutoff = thresholds[i] * sd;
        if (diff > cutoff) above[i] += 1;
        else if (-diff > cutoff) below[i] += 1;
      }
    }
  }

  return {
    ts,
    host,
    cpu_avg: baseline.cpu_avg,
    cpu_sd: baseline.cpu_sd,
    cpu_n: baseline.cpu_n,
    n_current,
    anomalies_above: above,
    anomalies_below: below,
    requests_avg: baseline.requests_avg,
    requests_sum: baseline.requests_sum,
    requests_n: baseline.requests_n,
    window_age_seconds: baseline.window_age_seconds,
    cpu_min: baseline.cpu_min,
    cpu_max: baseline.cpu_max,
  };
}

export { assembleTick };
