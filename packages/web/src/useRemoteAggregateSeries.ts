import { useEffect, useState } from 'react';
import {
  backoff,
  decode,
  type AggregateWireMsg,
  type HostTick,
} from '@pond-experiment/shared';
import type { ConnectionStatus } from './useRemoteLiveSeries';

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
  /** Most recent `HostTick` per host. Empty until the first append. */
  latestPerHost: ReadonlyMap<string, HostTick>;
  /**
   * σ-threshold list from the most recent snapshot frame. Empty
   * before the first snapshot arrives. Step-3 anomaly interpolation
   * will key off this; step 2 only displays it for diagnostics.
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
 * Connects to `url` (typically `ws://host:port/live-agg`), maintains a
 * per-host map of the latest `HostTick`, and exposes the threshold
 * list from the snapshot frame. Reconnect uses the same shared
 * `backoff` schedule as the raw stream so a flaky aggregator doesn't
 * fight one stream against the other.
 *
 * Step 2 deliberately stops at "latest per host" rather than mounting
 * a client `LiveSeries<aggregateSchema>` — the debug probe only needs
 * the current value; step 3 (bands migration) is the right moment to
 * introduce a schema and full windowing on the client side.
 */
export function useRemoteAggregateSeries(url: string): RemoteAggregateState {
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

  return { latestPerHost, thresholds, status, counters };
}
