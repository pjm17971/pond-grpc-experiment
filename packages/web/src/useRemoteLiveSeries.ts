import { useEffect, useState } from 'react';
import {
  LiveSeries,
  type LiveSeriesOptions,
  type TimeSeries,
} from 'pond-ts';
import { useSnapshot, type UseSnapshotOptions } from '@pond-ts/react';
import {
  backoff,
  decode,
  type RawWireMsg,
  type Schema,
} from '@pond-experiment/shared';

/**
 * Lifecycle of the WebSocket-backed mirror.
 *
 * - `connecting` — initial mount, before the first `open`.
 * - `connected` — after `open`, ingesting frames.
 * - `reconnecting` — server dropped us; waiting on the backoff
 *   timer or an in-flight reopen.
 * - `closed` — hook unmounted (terminal). The `LiveSeries` itself
 *   keeps its data but no new frames will arrive.
 *
 * Friction note for the eventual `@pond-ts/react` shape: a
 * generic `useRemoteLiveSeries` should expose this as a third
 * tuple slot so dashboards can show a connection indicator
 * without a parallel `useWebSocketStatus(url)` hook (which would
 * open a second socket).
 */
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/**
 * Apply a snapshot or append frame to the local `LiveSeries`. Pulled
 * out as a pure function so it can be unit-tested without spinning
 * up a React tree or a real WebSocket.
 *
 * Narrowed to `RawWireMsg` (the `/live` stream's frame shape) — the
 * M3.5 aggregate stream `/live-agg` carries `HostTick` rows that
 * don't match this `LiveSeries`'s schema, so accepting them here
 * would be a typing error waiting to happen. The aggregate stream
 * gets its own hook in a follow-up.
 *
 * `pushJson` (added in 0.11.4) takes the wire shape directly — same
 * `JsonRowForSchema<S>` `WireRow` is built from — and validates the
 * column count / value shapes against the schema at compile time.
 * Schema evolution now breaks this call site if the wire types and
 * the LiveSeries schema drift apart, instead of being swallowed by
 * an `as never` cast (the M1 hole, closed in 0.11.4).
 */
export function applyFrame(live: LiveSeries<Schema>, msg: RawWireMsg): void {
  live.pushJson(msg.rows);
}

/**
 * Symmetric to `useLiveSeries`, but the source of events is a remote
 * WebSocket emitting the snapshot+append wire protocol. Same return
 * shape: `[LiveSeries, TimeSeries | null]`.
 *
 * On mount: open `url`, ingest the first frame as the snapshot
 * (per-row push), then push every subsequent append frame's rows.
 *
 * On WS close (server restart, network hiccup): retry every
 * RECONNECT_DELAY_MS until either a fresh open succeeds or the hook
 * unmounts. The next snapshot ingests duplicates against the existing
 * LiveSeries — pond's `ordering` policy ('strict' default) drops them.
 *
 * v1 typing is concrete to the experiment's `Schema`. The wire
 * contract is schema-specific by design; a generic `useRemoteLiveSeries<S>`
 * is the M5/`@pond-ts/react` shape.
 */
export function useRemoteLiveSeries(
  url: string,
  options: LiveSeriesOptions<Schema>,
  hookOptions?: UseSnapshotOptions,
): [LiveSeries<Schema>, TimeSeries<Schema> | null, ConnectionStatus] {
  const [live] = useState(() => new LiveSeries(options));
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

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
        // A successful open resets the backoff schedule so a stable
        // connection that briefly hiccups doesn't inherit a long
        // delay from earlier failures.
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
        // Narrow to the raw-event firehose; ignore aggregate-stream
        // frames a misconfigured server might send on this socket.
        if (msg.type === 'snapshot' || msg.type === 'append') {
          applyFrame(live, msg);
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
      // onerror: do nothing. WS spec guarantees onclose fires after.
    };
    connect();

    return () => {
      cancelled = true;
      // `'closed'` is only observable as a transient between this
      // cleanup and the next effect run (e.g. a `[url, live]`
      // dep change). On unmount the indicator unmounts before any
      // render commits, so consumers never see it; on dep change
      // it briefly appears before the next `'connecting'`.
      setStatus('closed');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [url, live]);

  const snapshot = useSnapshot(live, hookOptions);
  return [live, snapshot, status];
}
