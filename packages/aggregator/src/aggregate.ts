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
 * Server-side aggregate-stream emitter, M3.5 step 4 shape.
 *
 * Builds the per-host tick aggregates the `/live-agg` wire ships
 * (`{ ts, host, cpu_avg, cpu_sd, cpu_n, n_current, anomalies_above[],
 * anomalies_below[] }`) by composing:
 *
 *   1. **Baseline pipeline** (pond, 1m window):
 *        live.partitionBy('host').rolling('1m', {
 *          cpu_avg: { from: 'cpu', using: 'avg' },
 *          cpu_sd:  { from: 'cpu', using: 'stdev' },
 *          cpu_n:   { from: 'cpu', using: 'count' },
 *        }, { trigger })
 *
 *   2. **Current-slice deque** (manual, `tickMs` window): a per-
 *      host `{ts, value}[]` updated off the source `live.on('batch',
 *      …)` listener. The aggregator iterates the recent slice at
 *      emission time to count threshold-exceeding samples against
 *      the baseline's mean/sd.
 *
 * Per the library agent's review during the 0.13 cycle, anomaly
 * density is **by definition two windows** — a long baseline (what's
 * normal) and a short leading edge (what just happened). The shape
 * is right; the implementation is hybrid because pond's live
 * partitioned rolling rejects custom function reducers at runtime
 * ("custom function reducers are not supported on live rolling")
 * and none of the built-ins return the bucket's full value list.
 * `'keep'` is constant-only, `'unique'` dedups, `'top${N}'` is
 * bounded. So the leading-edge sample collection lives in user code
 * for now. See `friction-notes/M3.5.md` for the library-extension
 * asks (custom-reducer-on-live + a `'collect'` built-in) that would
 * collapse this back to all-pond.
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

type Sample = { ts: number; value: number };

/**
 * Tolerance over `tickMs` for sample-deque trimming. A boundary
 * emission at `tickTs` should include samples in `(tickTs - tickMs,
 * tickTs]`; an extra 10 % of `tickMs` covers small wall-clock skew
 * between the producer and the aggregator without inflating the
 * effective slice.
 */
const TRIM_MAX_AGE_MULTIPLIER = 1.1;

export function startAggregate(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
  opts: AggregateOptions = {},
): { stop: () => void } {
  const tickMs = opts.tickMs ?? 200;
  const thresholds = opts.thresholds ?? DEFAULT_AGGREGATE_THRESHOLDS;
  const seq = Sequence.every(`${tickMs}ms`);
  const trigger = Trigger.clock(seq);

  const baselineStream: LiveSource<SeriesSchema> = live
    .partitionBy('host')
    .rolling(
      '1m',
      {
        cpu_avg: { from: 'cpu', using: 'avg' },
        cpu_sd: { from: 'cpu', using: 'stdev' },
        cpu_n: { from: 'cpu', using: 'count' },
      },
      { trigger },
    );

  // Per-host leading-edge deque. Updated on every event arriving
  // through `live`; trimmed at tick-emission time.
  const samplesByHost = new Map<string, Sample[]>();
  const trimAge = tickMs * TRIM_MAX_AGE_MULTIPLIER;

  const offSamples = live.on('batch', (events) => {
    for (const e of events) {
      const host = e.get('host');
      const value = e.get('cpu');
      if (typeof host !== 'string' || typeof value !== 'number') continue;
      const ts = e.key().begin();
      let deque = samplesByHost.get(host);
      if (!deque) {
        deque = [];
        samplesByHost.set(host, deque);
      }
      deque.push({ ts, value });
    }
  });

  const sliceSamplesAtTick = (host: string, tickTs: number): number[] => {
    const deque = samplesByHost.get(host);
    if (!deque || deque.length === 0) return [];
    const cutoff = tickTs - tickMs;
    // Drop samples older than cutoff (in-place trim from the front).
    let drop = 0;
    while (drop < deque.length && deque[drop].ts <= cutoff) drop += 1;
    if (drop > 0) deque.splice(0, drop);
    // Bound staleness: when a host goes silent the deque could keep
    // a few samples around just past the tick window. The trimAge
    // bound prevents accumulation.
    const staleCutoff = tickTs - trimAge;
    let staleDrop = 0;
    while (staleDrop < deque.length && deque[staleDrop].ts <= staleCutoff) {
      staleDrop += 1;
    }
    if (staleDrop > 0) deque.splice(0, staleDrop);
    // Snapshot the values for the consumer (anomaly counting).
    const out: number[] = [];
    for (const s of deque) {
      if (s.ts > cutoff && s.ts <= tickTs) out.push(s.value);
    }
    return out;
  };

  // Per-`ts` row collation. The baseline pipeline emits one row per
  // partition per tick boundary; on each emission we snapshot the
  // matching slice from the deque, compute anomaly counts, and
  // append to the pending row set for that `ts`. The microtask
  // drain emits one wire frame per `ts` at the end of the macrotask.
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

  const offBaseline = baselineStream.on(
    'event',
    (e: EventForSchema<SeriesSchema>) => {
      const ts = e.key().begin();
      const host = e.get('host');
      if (typeof host !== 'string') return;
      const cpu_avg = e.get('cpu_avg');
      const cpu_sd = e.get('cpu_sd');
      const cpu_n = e.get('cpu_n');
      const samples = sliceSamplesAtTick(host, ts);
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
      offBaseline();
      offSamples();
      samplesByHost.clear();
      pendingByTs.clear();
    },
  };
}

type BaselineParts = {
  cpu_avg: number | null;
  cpu_sd: number | null;
  cpu_n: number;
};

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
