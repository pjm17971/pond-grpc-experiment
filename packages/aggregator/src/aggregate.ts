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
 * Server-side aggregate-stream emitter, M3.5 step 1+ shape.
 *
 * Builds the per-host tick aggregates the `/live-agg` wire ships
 * (`{ ts, host, cpu_avg, cpu_sd, cpu_n }`) by composing pond 0.12's
 * partitioned-rolling primitives:
 *
 *     live.partitionBy('host').rolling('1m', { cpu: <reducer>, host: 'last' },
 *                                      { trigger: Trigger.clock(seq) })
 *
 * Each pipeline emits one synchronised row per known partition every
 * time *any* partition's source event crosses a sequence boundary.
 * Idle partitions emit too — same boundary `ts` — so the dashboard
 * gets a synchronised tick clock without per-partition skew.
 *
 * The wire's three CPU stats need three parallel pipelines because
 * `LivePartitionedSeries.rolling`'s `AggregateMap` accepts one reducer
 * per source column; the `AggregateOutputMap` shape (multiple named
 * outputs from one source column) the snapshot-side
 * `PartitionedTimeSeries.rolling` already supports isn't surfaced on
 * the live side yet. Three pipelines, each with its own reducer, are
 * merged by (ts, host) into a single `HostTick[]`. The merge is
 * deferred to a microtask after each batch so the three pipelines'
 * emits coalesce into one wire frame instead of three.
 *
 * What pond owns:
 * - The rolling-window storage (no per-host `times[]`/`values[]`)
 * - All three reducers (`avg`, `stdev`, `count`) — numerically correct
 *   and well-tested in the library
 * - The synchronised tick clock — `Trigger.clock(Sequence.every('200ms'))`
 *   guarantees same `ts` across all partitions and across the three
 *   pipelines
 * - Lifecycle/disposal — each pipeline returns a `LiveSource<S>`
 *   whose `.on('event', cb)` returns its own off()
 *
 * What the experiment still owns:
 * - The (ts, host) merge — small bookkeeping, one tryEmit per macrotask
 * - The wire envelope encoding (`AggregateAppendMsg` → JSON)
 *
 * See `friction-notes/M3.5.md` for the diff vs the previous
 * hand-rolled `HostAggregator` and the library extension that would
 * collapse this to a single pipeline.
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

  // Three parallel pipelines, each subscribes to `live.on('batch', …)`
  // independently. The clock trigger guarantees they all emit on the
  // same sequence boundaries — so for a given (ts, host) tuple, all
  // three eventually fire within the same JS macrotask.
  //
  // NOTE — partition tag retrieval: the documented pattern
  // `{ cpu: 'avg', host: 'last' }` is rejected by `LivePartitionedSyncRolling`'s
  // runtime check ("partition column 'host' collides with a
  // reducer-output column of the same name"). We rely on the
  // probe-with-debug-event below to confirm whether the unified
  // output's `Event` carries the partition key by another route.
  // Two windows: 1m for the band stats (avg, sd over the rolling
  // minute), `tickMs` for cpu_n (count of samples in this tick — the
  // per-tick semantic the wire's `cpu_n` is documented to carry).
  // The 1m rolling-window count reducer would also work but conflates
  // "samples this minute" with "samples this tick"; the dashboard's
  // render-gating use case wants the latter.
  const tickWindow = `${tickMs}ms` as const;
  const avgStream: LiveSource<SeriesSchema> = live
    .partitionBy('host')
    .rolling('1m', { cpu: 'avg' }, { trigger });
  const sdStream: LiveSource<SeriesSchema> = live
    .partitionBy('host')
    .rolling('1m', { cpu: 'stdev' }, { trigger });
  const countStream: LiveSource<SeriesSchema> = live
    .partitionBy('host')
    .rolling(tickWindow, { cpu: 'count' }, { trigger });

  // Partial-row accumulator keyed by (ts, host). Pond's three
  // pipelines fire for the same boundary `ts` across all known
  // partitions; one batch of source events can cross many boundaries
  // synchronously, so we buffer per-`ts` and emit on the next
  // microtask. A per-host map (the obvious choice) would be wrong:
  // pipeline A emitting for ts=50, then ts=100, then ts=150 in one
  // macrotask would overwrite per-host state, collapsing N frames
  // into 1.
  type Partial = {
    avg?: number | null;
    sd?: number | null;
    n?: number;
  };
  const partialsByTs = new Map<number, Map<string, Partial>>();

  // Latest fully-emitted boundary `ts` — the clock trigger's strict
  // monotonicity guards against duplicate frames if pond ever decides
  // to fire two emits at the same boundary (it shouldn't, but
  // mirroring the v1 monotonic guard costs ~one branch).
  let lastEmittedTs = -1;

  // Microtask scheduling: each macrotask of pipeline emits collapses
  // into one tryEmit so a single wire frame ships per tick rather
  // than one per host per pipeline. Re-armable.
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
    // Walk ts buckets in order. A bucket is ready when every host in
    // it has all three pipeline slots filled — pond's clock trigger
    // emits every known partition at the same `ts`, so a partial
    // bucket means we got here mid-flight and should leave it for
    // the next drain.
    const tsList = [...partialsByTs.keys()].sort((a, b) => a - b);
    for (const ts of tsList) {
      if (ts <= lastEmittedTs) {
        partialsByTs.delete(ts);
        continue;
      }
      const perHost = partialsByTs.get(ts);
      if (!perHost || perHost.size === 0) continue;
      const rows: HostTick[] = [];
      let allComplete = true;
      for (const [host, p] of perHost) {
        if (p.avg === undefined || p.sd === undefined || p.n === undefined) {
          allComplete = false;
          break;
        }
        rows.push({
          ts,
          host,
          cpu_avg: p.avg,
          cpu_sd: p.sd,
          cpu_n: p.n,
        });
      }
      if (!allComplete) continue;
      lastEmittedTs = ts;
      const msg: AggregateAppendMsg = { type: 'aggregate-append', rows };
      broadcast(encode(msg));
      partialsByTs.delete(ts);
    }
  };

  type StatKey = 'avg' | 'sd' | 'n';

  const acceptEvent = (
    e: EventForSchema<SeriesSchema>,
    key: StatKey,
  ): void => {
    // The unified output's key is `Time | Interval | TimeRange`;
    // `begin()` is the common accessor (returns the inclusive start
    // ms-epoch on all three) so we don't have to narrow.
    const ts = e.key().begin();
    // Output schema is the unified `SeriesSchema`, so we read columns
    // by name through generic accessors. `cpu` carries the stat
    // (avg/stdev/count, per pipeline); `host` is auto-injected by
    // pond as the partition tag (and importantly, listing it in the
    // mapping hits a runtime collision check — pond's runtime
    // disagrees with `LivePartitionedSeries.rolling`'s docstring on
    // this; the auto-injection is the actual contract).
    const host = e.get('host');
    if (typeof host !== 'string') return;
    const value = e.get('cpu');
    let perHost = partialsByTs.get(ts);
    if (!perHost) {
      perHost = new Map();
      partialsByTs.set(ts, perHost);
    }
    let p = perHost.get(host);
    if (!p) {
      p = {};
      perHost.set(host, p);
    }
    if (key === 'avg') p.avg = (value as number | null) ?? null;
    else if (key === 'sd') p.sd = (value as number | null) ?? null;
    else p.n = typeof value === 'number' ? value : 0;
    scheduleEmit();
  };

  const offAvg = avgStream.on('event', (e) => acceptEvent(e, 'avg'));
  const offSd = sdStream.on('event', (e) => acceptEvent(e, 'sd'));
  const offCount = countStream.on('event', (e) => acceptEvent(e, 'n'));

  return {
    stop: () => {
      offAvg();
      offSd();
      offCount();
      partialsByTs.clear();
    },
  };
}
