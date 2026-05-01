import { useEffect, useState } from 'react';
import { LiveSeries } from 'pond-ts';
import type { JsonRowForSchema } from 'pond-ts/types';
import {
  aggregateSchema,
  backoff,
  decode,
  type AggregateSchema,
  type AggregateWireMsg,
  type HostTick,
} from '@pond-experiment/shared';
import type { ConnectionStatus } from './useRemoteLiveSeries';

type AggregateRow = JsonRowForSchema<AggregateSchema>;

/**
 * Convert a wire-shape `HostTick` (object form, the dashboard agent's
 * `WIRE.md` contract) into the tuple form `pond-ts.LiveSeries.pushJson`
 * accepts (`[time, host, cpu_avg, cpu_sd, cpu_n]`). One per-tick row;
 * stays close to the rest of the experiment's "convert at the boundary"
 * pattern.
 */
export function tickToRow(tick: HostTick): AggregateRow {
  return [tick.ts, tick.host, tick.cpu_avg, tick.cpu_sd, tick.cpu_n];
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
 * Sum of `cpu_n` across every row in an aggregate frame — i.e. how
 * many raw events the aggregator folded into this single frame.
 * Useful for the dashboard's compression-ratio readout: aggregate
 * frame count vs raw-event count tells you how much wire traffic the
 * tick clock is saving vs the per-event firehose.
 */
export function sumFrameCpuN(msg: AggregateWireMsg): number {
  let total = 0;
  for (const row of msg.rows) total += row.cpu_n;
  return total;
}

/**
 * Running counters for the aggregate stream's compression ratio.
 * Tracked since the most recent (re)connect; reset to zero on URL
 * change. WS reconnects continue accumulating across the gap rather
 * than resetting — the producer's host load is the same load,
 * regardless of whether the dashboard's socket flapped.
 */
export type AggregateCounters = {
  /** `cpu_n` sum across rows of the most recent aggregate-append. */
  latestFrameEvents: number;
  /** Aggregate-append frames received since connect. */
  totalFrames: number;
  /** Cumulative `cpu_n` sum across every aggregate-append received. */
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
  // Fresh `LiveSeries` per URL change. The series accumulates rows
  // as the WS pumps them; pond's retention policy drops rows past
  // the configured maxAge so this doesn't grow without bound. 6m
  // matches the raw `live`'s retention so 5m windowing has slack.
  const [liveSeries] = useState(
    () =>
      new LiveSeries({
        name: 'aggregate',
        schema: aggregateSchema,
        retention: { maxAge: '6m' },
      }),
  );
  const [latestPerHost, setLatestPerHost] = useState<
    ReadonlyMap<string, HostTick>
  >(() => new Map());
  const [thresholds, setThresholds] = useState<ReadonlyArray<number>>([]);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [counters, setCounters] = useState<AggregateCounters>(ZERO_COUNTERS);

  useEffect(() => {
    // Reset compression-ratio counters when the URL changes (treated
    // as a fresh subscription). Reconnect to the same URL preserves
    // the running totals — see `AggregateCounters` doc.
    setCounters(ZERO_COUNTERS);
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
          const frameEvents = sumFrameCpuN(msg);
          setCounters((prev) => ({
            latestFrameEvents: frameEvents,
            totalFrames: prev.totalFrames + 1,
            totalEvents: prev.totalEvents + frameEvents,
          }));
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

  return { liveSeries, latestPerHost, thresholds, status, counters };
}
