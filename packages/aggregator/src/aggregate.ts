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
};

type BaselineParts = {
  cpu_avg: number | null;
  cpu_sd: number | null;
  cpu_n: number;
  requests_avg: number | null;
  requests_sum: number;
  requests_n: number;
};

export function startAggregate(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
  opts: AggregateOptions = {},
): { stop: () => void } {
  const tickMs = opts.tickMs ?? 200;
  const thresholds = opts.thresholds ?? DEFAULT_AGGREGATE_THRESHOLDS;
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
  const fused: LiveSource<SeriesSchema> = live
    .partitionBy('host')
    .rolling(
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
        },
      },
      { trigger },
    );

  // Step 6 — globals: aggregator-wide stats emitted on the same
  // tick clock as the per-host fused rolling. All three are
  // tracked manually off `live.on('batch'/'evict')` callbacks
  // rather than running a parallel non-partitioned pond rolling.
  //
  // **Why not pond rolling for events_per_sec?**
  //
  // The natural shape would be `live.rolling({'1s': {events_per_sec:
  // 'count'}}, {trigger})` — exercising the new non-partitioned
  // fused-rolling overload (PR #20 / pond 0.15.0). But at 87k+
  // events/sec, every raw event has to flow through the non-
  // partitioned rolling's per-event ingest pipeline (fanout → push
  // → routeEvent → reducer add). The partitioned 1m baseline
  // splits this work across 100 hosts (~870 events/sec each); the
  // non-partitioned variant takes the full firehose serially. In
  // practice this dropped throughput from 88k/s to 21k/s and tick
  // emission from 5 fps to 1.2 fps at the 87k/s bench point — a
  // ~4× regression, far worse than the V7→V6 gap PR #19 documented.
  //
  // Manual counter + boundary-deltad rate is O(1) per event and
  // computes an equivalent value (raw events in the trailing tick
  // window). Friction-note candidate for the library: non-
  // partitioned rolling is currently the only path that doesn't
  // shard ingest by partition, and it bottlenecks at firehose
  // rates. Same `samples()` reducer would exhibit a similar shape.
  let eventsIngested = 0;
  let eventsEvicted = 0;
  let prevEventsIngested = 0;
  let prevTickTs: number | null = null;
  const offBatch = live.on('batch', (events) => {
    eventsIngested += events.length;
  });
  const offEvict = live.on('evict', (events) => {
    eventsEvicted += events.length;
  });

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

      // Globals: derived per-tick from the running counters. Rate
      // is the per-tick delta divided by elapsed wall-clock. First
      // tick has no `prev` to subtract from — fall back to 0 rather
      // than dividing-by-zero or shipping an unbounded rate.
      const dtSec =
        prevTickTs == null ? 0 : Math.max(0.001, (ts - prevTickTs) / 1000);
      const eps =
        dtSec === 0 ? 0 : (eventsIngested - prevEventsIngested) / dtSec;
      const globals: GlobalsTick = {
        ts,
        events_ingested_total: eventsIngested,
        events_per_sec: Math.round(eps),
        evicted_total: eventsEvicted,
      };
      prevEventsIngested = eventsIngested;
      prevTickTs = ts;

      const msg: AggregateAppendMsg = {
        type: 'aggregate-append',
        rows,
        globals,
      };
      broadcast(encode(msg));
      pendingByTs.delete(ts);
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
      offBatch();
      offEvict();
      pendingByTs.clear();
    },
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
  };
}

export { assembleTick };
