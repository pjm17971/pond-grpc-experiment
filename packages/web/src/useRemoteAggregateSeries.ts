import { useEffect, useState } from 'react';
import { useLiveSeries } from '@pond-ts/react';
import type { LiveSeries } from 'pond-ts';
import type { JsonRowForSchema } from 'pond-ts/types';
import {
  aggregateSchema,
  backoff,
  decode,
  type AggregateSchema,
  type AggregateWireMsg,
  type GlobalsTick,
  type HostTick,
} from '@pond-experiment/shared';
import type { ConnectionStatus } from './useRemoteLiveSeries';

type AggregateRow = JsonRowForSchema<AggregateSchema>;

/**
 * Convert a wire-shape `HostTick` (object form, the dashboard agent's
 * `WIRE.md` contract) into the tuple form `pond-ts.LiveSeries.pushJson`
 * accepts. Tuple order matches `aggregateSchema`'s column order:
 * `[time, host, cpu_avg, cpu_sd, cpu_n, n_current, anomalies_above,
 * anomalies_below, requests_avg, requests_sum, requests_n,
 * window_age_seconds, cpu_min, cpu_max]`. Stays close to the rest
 * of the experiment's "convert at the boundary" pattern.
 */
export function tickToRow(tick: HostTick): AggregateRow {
  return [
    tick.ts,
    tick.host,
    tick.cpu_avg,
    tick.cpu_sd,
    tick.cpu_n,
    tick.n_current,
    tick.anomalies_above,
    tick.anomalies_below,
    tick.requests_avg,
    tick.requests_sum,
    tick.requests_n,
    tick.window_age_seconds,
    tick.cpu_min,
    tick.cpu_max,
  ];
}

/**
 * Apply an aggregate snapshot or append frame to the per-host
 * latest-tick map. Pure function so step-2 tests don't need a real
 * WebSocket. Returns a new `Map` (immutable update) so React state
 * comparisons see the change.
 *
 * Both snapshot and append carry the same `HostTick[]` shape; the
 * snapshot is just the (currently empty) backfill on connect. Step 1
 * of M3.5 ships an empty `rows` array on snapshot — this function
 * tolerates it without special-casing.
 */
export function applyAggregateFrame(
  latest: ReadonlyMap<string, HostTick>,
  msg: AggregateWireMsg,
): ReadonlyMap<string, HostTick> {
  if (msg.rows.length === 0) return latest;
  const next = new Map(latest);
  for (const row of msg.rows) {
    next.set(row.host, row);
  }
  return next;
}

/**
 * Sum of `cpu_n` across every row in an aggregate frame — i.e. the
 * total bucket density represented in this frame. **Not the same as
 * "raw events ingested for this tick"**: each raw event contributes
 * to `cpu_n` for ~300 frames (1m baseline window × 5 fps), so this
 * sum runs ~300× higher than the per-tick raw-event delta. Earlier
 * versions of the dashboard's compression readout misread the two
 * as equivalent and reported inflated numbers; the dashboard now
 * sources the true per-frame raw-event count from
 * `globals.events_ingested_total` deltas instead. This helper
 * stays for diagnostic / test use — bucket density is a real
 * signal, just not "raw events per frame".
 */
export function sumFrameCpuN(msg: AggregateWireMsg): number {
  let total = 0;
  for (const row of msg.rows) total += row.cpu_n;
  return total;
}

/**
 * Running counters for the aggregate stream's true compression ratio.
 * Tracked since this dashboard's first frame; reset to zero on URL
 * change. WS reconnects continue accumulating across the gap (the
 * aggregator's `events_ingested_total` is monotonic across the
 * dashboard's reconnects); a true aggregator restart is detected
 * via the counter going backwards and re-anchors.
 *
 * **Earlier versions used `cpu_n` sums** (the bucket count over the
 * 1m baseline window) and reported headline numbers like "418k raw
 * events folded into latest frame" — which were ~300× over the
 * actual per-tick raw-event count, because every event contributes
 * to ~300 frames worth of `cpu_n` (1m window × 5 fps). Those
 * numbers told a real story (sum-of-bucket-density per frame) but
 * read as the wire's compression ratio, which they weren't. The
 * counters now anchor to `globals.events_ingested_total` deltas so
 * "raw events per frame" reads as actual ingest density.
 */
export type AggregateCounters = {
  /**
   * Raw events ingested between this frame and the previous one
   * (`globals.events_ingested_total` delta). At a steady gRPC ingest
   * of 7000/sec with 5 fps tick frames, this reads ~1400.
   */
  latestFrameEvents: number;
  /** Aggregate-append frames received since connect. */
  totalFrames: number;
  /**
   * Raw events ingested since this dashboard's first frame (so
   * `totalEvents / totalFrames` is the average raw events per
   * frame, the true wire compression ratio).
   */
  totalEvents: number;
};

export type RemoteAggregateState = {
  /**
   * Mounted `LiveSeries<AggregateSchema>` reflecting the aggregate
   * wire (one event per `HostTick` row). The dashboard runs pond
   * pipelines (`partitionBy('host')`, windowing, smoothing, etc.)
   * over this series the same way `useRemoteLiveSeries` exposes the
   * raw `LiveSeries` for `/live`. Its lifecycle follows the hook's:
   * a fresh `LiveSeries` is constructed once per `url`, and the WS
   * pumps `aggregate-snapshot` + `aggregate-append` rows into it.
   */
  liveSeries: LiveSeries<AggregateSchema>;
  /** Most recent `HostTick` per host. Empty until the first append. */
  latestPerHost: ReadonlyMap<string, HostTick>;
  /**
   * σ-threshold list from the most recent snapshot frame. Empty
   * before the first snapshot arrives. Step-4 anomaly interpolation
   * will key off this; step 2's probe and step 3's bands display it
   * for diagnostics.
   */
  thresholds: ReadonlyArray<number>;
  status: ConnectionStatus;
  counters: AggregateCounters;
  /**
   * Most recent `GlobalsTick` from the wire (step 6+). `null` before
   * the first frame carrying globals arrives. Drives the dashboard's
   * headline numbers (Total events, Event rate, Evicted) — sourced
   * from the aggregator's gRPC-side counters rather than the
   * dashboard's own `LiveSeries.length`, so they reflect the true
   * firehose throughput regardless of the wire's tick-frame
   * compression. Pre-step-6 servers don't ship `globals`; the
   * dashboard should fall back to a "—" / "—/s" display in that
   * case rather than misreporting.
   */
  latestGlobals: GlobalsTick | null;
};

const ZERO_COUNTERS: AggregateCounters = {
  latestFrameEvents: 0,
  totalFrames: 0,
  totalEvents: 0,
};

/**
 * Sibling of `useRemoteLiveSeries` for the M3.5 aggregate stream.
 *
 * Connects to `url` (typically `ws://host:port/live-agg`), pumps each
 * `aggregate-snapshot`/`aggregate-append` frame into a mounted
 * `LiveSeries<AggregateSchema>`, and also keeps a per-host map of
 * the latest `HostTick` for the diagnostic probe. Reconnect uses the
 * same shared `backoff` schedule as the raw stream so a flaky
 * aggregator doesn't fight one stream against the other.
 *
 * Step 3 introduced the mounted `LiveSeries` so the dashboard can
 * source the CPU bands + smoothed line directly off the wire's
 * `cpu_avg`/`cpu_sd` columns instead of recomputing baseline from
 * raw events. The `latestPerHost` map kept its place — it's the
 * cheapest way to drive the diagnostic probe and (in step 4+) the
 * "current cell" anomaly readout.
 */
export function useRemoteAggregateSeries(url: string): RemoteAggregateState {
  // `useLiveSeries` from `@pond-ts/react` owns the LiveSeries
  // lifecycle for the component's lifetime — created once on mount,
  // stable ref afterwards. URL changes don't reconstruct it (the
  // `useEffect` below opens a new WS but pushes into the same
  // series); pond's retention policy bounds memory. 6m matches the
  // raw `live`'s retention so 5m windowing has slack.
  //
  // The discarded second slot is a throttled `TimeSeries` snapshot
  // of the whole series — not what `useDashboardData` wants here
  // (it does its own `useWindow(aggLive, '5m')` for the chart's
  // 5-minute back-window).
  const [liveSeries] = useLiveSeries({
    name: 'aggregate',
    schema: aggregateSchema,
    retention: { maxAge: '6m' },
  });
  const [latestPerHost, setLatestPerHost] = useState<
    ReadonlyMap<string, HostTick>
  >(() => new Map());
  const [thresholds, setThresholds] = useState<ReadonlyArray<number>>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [counters, setCounters] = useState<AggregateCounters>(ZERO_COUNTERS);
  const [latestGlobals, setLatestGlobals] = useState<GlobalsTick | null>(null);

  useEffect(() => {
    // Reset compression-ratio counters when the URL changes (treated
    // as a fresh subscription). Reconnect to the same URL preserves
    // the running totals — see `AggregateCounters` doc. Globals
    // come from the wire on every frame so we don't reset them
    // explicitly — the next aggregate-append will overwrite.
    setCounters(ZERO_COUNTERS);
    // Per-effect-run anchors for the true-compression counter.
    // Reset alongside `setCounters(ZERO_COUNTERS)` because they
    // share the URL's lifecycle.
    let initialEventsIngested: number | null = null;
    let prevEventsIngested: number | null = null;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isReconnect = false;
    let attempt = 0;

    const connect = () => {
      setStatus(isReconnect ? 'reconnecting' : 'connecting');
      ws = new WebSocket(url);
      ws.onopen = () => {
        if (!cancelled) setStatus('connected');
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        // Cleanup may have run between this frame being queued and us
        // receiving it (URL change → cancel → close, but a buffered
        // frame fires before `onclose`). Without this guard a stale
        // frame from the old subscription would briefly write into
        // the new view.
        if (cancelled) return;
        const msg = decode(ev.data as string);
        if (msg.type !== 'aggregate-snapshot' && msg.type !== 'aggregate-append') {
          // Misconfigured server sending raw frames on this socket —
          // drop silently rather than schema-crash.
          return;
        }
        if (msg.type === 'aggregate-snapshot') {
          setThresholds(msg.thresholds);
          // Snapshot may carry a tail of recent globals ticks (step
          // 8 backfill territory; step 6 ships either an empty
          // array or just the latest tick). Take the last entry as
          // the current globals; per-tick appends replace it below.
          if (msg.globals && msg.globals.length > 0) {
            setLatestGlobals(msg.globals[msg.globals.length - 1]);
          }
        }
        // Push every row into the mounted LiveSeries so windowed
        // queries (`useWindow`, `partitionBy`) work over the wire.
        // Same convert-at-the-boundary pattern the raw `applyFrame`
        // uses; pond validates each row against `aggregateSchema` and
        // throws on shape drift.
        if (msg.rows.length > 0) {
          liveSeries.pushJson(msg.rows.map(tickToRow));
        }
        // Functional update — `prev` is always the freshest state in
        // React's queue. Reading `latestPerHost` from a closure or a
        // ref would race when two frames land between commits (one
        // overwriting the other's contribution). `applyAggregateFrame`
        // returns the same Map reference on empty rows, so React's
        // shallow-state equality skips the re-render in that case.
        setLatestPerHost((prev) => applyAggregateFrame(prev, msg));
        if (msg.type === 'aggregate-append') {
          // True per-frame raw-event delta from globals. Falls back
          // to 0 for pre-step-6 servers that don't ship `globals`
          // (the counters then just report "0 raw events per
          // frame", which is honest if uninformative — the right
          // long-term answer is requiring globals on every frame).
          const ingested = msg.globals?.events_ingested_total;
          if (typeof ingested === 'number') {
            // Aggregator restart detection: if the cumulative count
            // goes backward, the aggregator was reset. Re-anchor.
            if (
              prevEventsIngested !== null &&
              ingested < prevEventsIngested
            ) {
              initialEventsIngested = ingested;
              prevEventsIngested = ingested;
            }
            if (initialEventsIngested === null) {
              initialEventsIngested = ingested;
            }
            const frameEvents =
              prevEventsIngested === null
                ? 0
                : ingested - prevEventsIngested;
            prevEventsIngested = ingested;
            const eventsThisSession = ingested - initialEventsIngested;
            setCounters((prev) => ({
              latestFrameEvents: frameEvents,
              totalFrames: prev.totalFrames + 1,
              totalEvents: eventsThisSession,
            }));
          } else {
            // No globals on the wire — count frames only, leave
            // event counts at zero so the displayed compression
            // reads as "—" rather than a fabricated number.
            setCounters((prev) => ({
              latestFrameEvents: 0,
              totalFrames: prev.totalFrames + 1,
              totalEvents: prev.totalEvents,
            }));
          }
          if (msg.globals) {
            setLatestGlobals(msg.globals);
          }
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setStatus('reconnecting');
        isReconnect = true;
        const delay = backoff(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      cancelled = true;
      setStatus('closed');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [url]);

  return {
    liveSeries,
    latestPerHost,
    thresholds,
    status,
    counters,
    latestGlobals,
  };
}
