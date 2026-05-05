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
  type HostTick,
  type Schema,
  encode,
} from '@pond-experiment/shared';

/**
 * Server-side aggregate-stream emitter, M3.5 step 4 / V8 shape.
 *
 * Builds the per-host tick aggregates the `/live-agg` wire ships
 * (`{ ts, host, cpu_avg, cpu_sd, cpu_n, n_current, anomalies_above[],
 * anomalies_below[] }`) by composing **one fused multi-window
 * partitioned rolling** clocked off `Trigger.clock(seq)`:
 *
 *   live.partitionBy('host').rolling(
 *     {
 *       '1m':         { cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count' },
 *       `${tickMs}ms`: { cpu_samples: 'samples' },
 *     },
 *     { trigger },
 *   );
 *
 * One per-event ingest pass updates both windows' reducer state in
 * the same partition object; one boundary check fires; one
 * synchronised burst emits a single merged event per partition per
 * tick. Every column the consumer cares about is on that one event.
 *
 * History:
 * - V6 (#16) — manual per-host deque off `live.on('batch', cb)` for
 *   the leading-edge slice; one pond rolling for baseline.
 * - V7 (#18) — pond 0.14.2 `samples()` reducer, two parallel
 *   rollings sharing one trigger. Cleaner shape; ~19% throughput
 *   regression at ceiling because every event flowed through two
 *   ingest pipelines (see PR #19's profile diff).
 * - V8 (this) — pond 0.15.0 fused rolling delivers the API proposed
 *   in PR #20 (RFC). Two windows, one rolling, one ingest pass.
 *
 * The pendingByTs collation below stays — pond emits one event per
 * partition per tick, and the wire ships one frame per tick across
 * all partitions. The collation just merges the per-partition
 * bursts into a single `aggregate-append`. The V7 per-`(ts, host)`
 * parts buffer (waiting for the second rolling's event to arrive)
 * is gone — fused emits one event with both halves at once.
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
        },
        [`${tickMs}ms`]: {
          cpu_samples: { from: 'cpu', using: 'samples' },
        },
      },
      { trigger },
    );

  // Per-`ts` row collation — pond fires one event per partition per
  // tick boundary; the wire ships one frame per tick across all
  // partitions. The microtask drain accumulates the per-partition
  // events for a given `ts` into a single `aggregate-append` frame
  // and emits it in monotonic order.
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
      const msg: AggregateAppendMsg = { type: 'aggregate-append', rows };
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
  };
}

export { assembleTick };
