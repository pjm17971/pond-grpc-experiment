import {
  Sequence,
  Trigger,
  type LiveSeries,
  type LiveSource,
  type SeriesSchema,
  type EventForSchema,
} from 'pond-ts';
import {
  type AggregateAppendMsg,
  type HostTick,
  type Schema,
  encode,
} from '@pond-experiment/shared';

/**
 * Server-side aggregate-stream emitter, M3.5 step 1 shape.
 *
 * Builds the per-host tick aggregates the `/live-agg` wire ships
 * (`{ ts, host, cpu_avg, cpu_sd, cpu_n }`) by composing pond 0.13's
 * partitioned-rolling primitives. With pond 0.13's `AggregateOutputMap`
 * overload on `LivePartitionedSeries.rolling`, three named outputs
 * come from one source column off a single rolling buffer:
 *
 *     live.partitionBy('host').rolling('1m', {
 *       cpu_avg: { from: 'cpu', using: 'avg' },
 *       cpu_sd:  { from: 'cpu', using: 'stdev' },
 *       cpu_n:   { from: 'cpu', using: 'count' },
 *     }, { trigger: Trigger.clock(seq) });
 *
 * Each emission is one synchronised row per known partition every
 * time any partition's source event crosses a sequence boundary.
 * Partition tag (`host`) is auto-injected into the unified output's
 * schema; the experiment reads it via `e.get('host')`.
 *
 * Conceptual frame (the library agent's correction during this
 * milestone): `cpu_n` is the **bucket's own count** — gating signal
 * for the consumer ("are mean/sd backed by enough samples to be
 * meaningful?"). It is NOT a per-tick sample count. The trigger only
 * controls *when the bucket reports*; the bucket is still the bucket.
 *
 * The 200ms current-slice window earlier drafts of this file used
 * was speculative work for an unbuilt feature; it's gone. When step
 * 4+ adds anomaly density, a SECOND parallel rolling on a short
 * leading-edge window (current state vs baseline) will come back —
 * but with structurally different fields (`n_current`,
 * `anomalies_above[]`, `anomalies_below[]`), not duplicated stats.
 *
 * What pond owns:
 * - The rolling-window storage (one buffer per partition)
 * - All three reducers, numerically correct and library-tested
 * - The synchronised tick clock (`Trigger.clock`)
 * - Auto-injection of the partition tag in the unified output
 *
 * What the experiment still owns:
 * - The wire envelope encoding (`AggregateAppendMsg` → JSON)
 * - The microtask-deferred per-`ts` row collation (one frame per
 *   boundary across all partitions)
 */
export type AggregateOptions = {
  /** Tick cadence in milliseconds. Default 200, matches `WIRE.md`. */
  tickMs?: number;
};

export function startAggregate(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
  opts: AggregateOptions = {},
): { stop: () => void } {
  const tickMs = opts.tickMs ?? 200;
  const seq = Sequence.every(`${tickMs}ms`);
  const trigger = Trigger.clock(seq);

  // Single rolling pipeline producing all three CPU stats from one
  // 1m buffer per host. cpu_n is the bucket's count (gating signal),
  // not a per-tick count.
  const stream: LiveSource<SeriesSchema> = live.partitionBy('host').rolling(
    '1m',
    {
      cpu_avg: { from: 'cpu', using: 'avg' },
      cpu_sd: { from: 'cpu', using: 'stdev' },
      cpu_n: { from: 'cpu', using: 'count' },
    },
    { trigger },
  );

  // Per-`ts` row collation. Pond's clock trigger fires every known
  // partition at the same boundary `ts`, so we accumulate rows in
  // the current macrotask and emit one wire frame per boundary on
  // the next microtask. Using `Map<ts, HostTick[]>` so a synchronous
  // batch that crosses multiple boundaries doesn't collapse into one
  // frame.
  const pendingByTs = new Map<number, HostTick[]>();

  // Strict monotonicity guard against duplicate frames if the library
  // ever fires two emits at the same boundary (it shouldn't, but
  // mirroring the v1 guard costs ~one branch).
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

  const off = stream.on('event', (e: EventForSchema<SeriesSchema>) => {
    const ts = e.key().begin();
    const host = e.get('host');
    if (typeof host !== 'string') return;
    const cpu_avg = e.get('cpu_avg');
    const cpu_sd = e.get('cpu_sd');
    const cpu_n = e.get('cpu_n');
    const row: HostTick = {
      ts,
      host,
      cpu_avg: typeof cpu_avg === 'number' ? cpu_avg : null,
      cpu_sd: typeof cpu_sd === 'number' ? cpu_sd : null,
      cpu_n: typeof cpu_n === 'number' ? cpu_n : 0,
    };
    let rows = pendingByTs.get(ts);
    if (!rows) {
      rows = [];
      pendingByTs.set(ts, rows);
    }
    rows.push(row);
    scheduleEmit();
  });

  return {
    stop: () => {
      off();
      pendingByTs.clear();
    },
  };
}
