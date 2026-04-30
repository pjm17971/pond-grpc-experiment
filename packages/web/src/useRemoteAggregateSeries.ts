import { useEffect, useRef, useState } from 'react';
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
  // Stable ref so the WS handler doesn't capture stale state on
  // re-renders (latestPerHost changes every tick).
  const latestRef = useRef<ReadonlyMap<string, HostTick>>(new Map());
  latestRef.current = latestPerHost;

  useEffect(() => {
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
        const msg = decode(ev.data as string);
        if (msg.type !== 'aggregate-snapshot' && msg.type !== 'aggregate-append') {
          // Misconfigured server sending raw frames on this socket —
          // drop silently rather than schema-crash.
          return;
        }
        if (msg.type === 'aggregate-snapshot') {
          setThresholds(msg.thresholds);
        }
        const next = applyAggregateFrame(latestRef.current, msg);
        if (next !== latestRef.current) setLatestPerHost(next);
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

  return { latestPerHost, thresholds, status };
}
