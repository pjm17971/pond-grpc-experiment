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
 * Server-side aggregate-stream emitter, M3.5 step 4 / V7 shape.
 *
 * Builds the per-host tick aggregates the `/live-agg` wire ships
 * (`{ ts, host, cpu_avg, cpu_sd, cpu_n, n_current, anomalies_above[],
 * anomalies_below[] }`) by composing **two synchronised partitioned
 * rollings**, both clocked off the same `Trigger.clock(seq)`:
 *
 *   1. **Baseline rolling** (1m window):
 *        live.partitionBy('host').rolling('1m', {
 *          cpu_avg: { from: 'cpu', using: 'avg' },
 *          cpu_sd:  { from: 'cpu', using: 'stdev' },
 *          cpu_n:   { from: 'cpu', using: 'count' },
 *        }, { trigger })
 *
 *   2. **Slice rolling** (`tickMs` window, default 200ms):
 *        live.partitionBy('host').rolling('200ms', {
 *          cpu_samples: { from: 'cpu', using: 'samples' },
 *        }, { trigger })
 *
 * Both rollings subscribe to the same `byHost` partition machinery,
 * share the same clock sequence, and therefore burst at the same
 * boundary `ts`. Each tick boundary produces two events per known
 * host (one per rolling); the join below collates them per
 * `(ts, host)` and emits one wire row per host per tick.
 *
 * The `samples` reducer is built-in (v0.14.2) — it returns the bucket's
 * full sample list as `ReadonlyArray<number>`, which is what anomaly
 * counting needs at the leading edge against the baseline mean/sd. V6
 * faked this with a manual per-host deque off `live.on('batch', …)`
 * because no built-in returned the bucket contents and pond's live
 * partitioned rolling rejects custom function reducers; the pre-V7
 * note in `friction-notes/M3.5.md` documents that workaround.
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

type Parts = {
  baseline?: BaselineParts;
  samples?: ReadonlyArray<number>;
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

  // Both rollings hang off the same partition. `partitionBy` is the
  // bookkeeping layer that fans events out to per-host LiveSources;
  // creating two rollings on the same `byHost` reuses that fan-out.
  const byHost = live.partitionBy('host');

  const baselineStream: LiveSource<SeriesSchema> = byHost.rolling(
    '1m',
    {
      cpu_avg: { from: 'cpu', using: 'avg' },
      cpu_sd: { from: 'cpu', using: 'stdev' },
      cpu_n: { from: 'cpu', using: 'count' },
    },
    { trigger },
  );

  const sliceStream: LiveSource<SeriesSchema> = byHost.rolling(
    `${tickMs}ms`,
    {
      cpu_samples: { from: 'cpu', using: 'samples' },
    },
    { trigger },
  );

  // Per-`(ts, host)` parts buffer. Both rollings burst on each clock
  // boundary; the events fire synchronously inside the same JS task
  // (pond dispatches subscribers in order). The microtask drain runs
  // after the task finishes — by then both halves are present for
  // every host the rollings know about.
  const pendingByTs = new Map<number, Map<string, Parts>>();
  let lastEmittedTs = -1;
  let scheduled = false;

  const partsFor = (ts: number, host: string): Parts => {
    let perHost = pendingByTs.get(ts);
    if (!perHost) {
      perHost = new Map();
      pendingByTs.set(ts, perHost);
    }
    let parts = perHost.get(host);
    if (!parts) {
      parts = {};
      perHost.set(host, parts);
    }
    return parts;
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
      const perHost = pendingByTs.get(ts);
      if (!perHost || perHost.size === 0) continue;
      const rows: HostTick[] = [];
      for (const [host, parts] of perHost) {
        // Only emit hosts that have a baseline. WIRE.md's contract:
        // "one HostTick per host that had any samples in the rolling
        // 1m window at tick time; silent hosts are omitted." Slice-
        // only entries (no baseline event for this tick) shouldn't
        // happen — slice's 200ms window is a strict subset of
        // baseline's 1m window — but defending against it costs
        // nothing.
        if (!parts.baseline) continue;
        rows.push(
          assembleTick(
            ts,
            host,
            parts.baseline,
            parts.samples ?? [],
            thresholds,
          ),
        );
      }
      if (rows.length === 0) {
        pendingByTs.delete(ts);
        continue;
      }
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
      partsFor(ts, host).baseline = {
        cpu_avg: typeof cpu_avg === 'number' ? cpu_avg : null,
        cpu_sd: typeof cpu_sd === 'number' ? cpu_sd : null,
        cpu_n: typeof cpu_n === 'number' ? cpu_n : 0,
      };
      scheduleEmit();
    },
  );

  const offSlice = sliceStream.on(
    'event',
    (e: EventForSchema<SeriesSchema>) => {
      const ts = e.key().begin();
      const host = e.get('host');
      if (typeof host !== 'string') return;
      // `samples` reducer returns `ReadonlyArray<number> | undefined`
      // (undefined when the window is gated or empty). Normalise to
      // an empty array so downstream consumers see a regular shape.
      const raw = e.get('cpu_samples');
      const samples: ReadonlyArray<number> = Array.isArray(raw)
        ? (raw as ReadonlyArray<number>)
        : [];
      partsFor(ts, host).samples = samples;
      scheduleEmit();
    },
  );

  return {
    stop: () => {
      offBaseline();
      offSlice();
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
