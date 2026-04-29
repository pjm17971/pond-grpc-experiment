import { useEffect, useState } from 'react';
import {
  LiveSeries,
  type LiveSeriesOptions,
  type TimeSeries,
} from 'pond-ts';
import { useSnapshot, type UseSnapshotOptions } from '@pond-ts/react';
import { decode, type Schema, type WireMsg } from '@pond-experiment/shared';

const RECONNECT_DELAY_MS = 1000;

/**
 * Apply a snapshot or append frame to the local `LiveSeries` by
 * per-row push. Pulled out as a pure function so it can be unit-tested
 * without spinning up a React tree or a real WebSocket. The cast to
 * `never` is needed because `JsonRowForSchema` permits null per
 * column while `RowForSchema` does not — friction-noted.
 */
export function applyFrame(live: LiveSeries<Schema>, msg: WireMsg): void {
  for (const row of msg.rows) {
    live.push(row as never);
  }
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
): [LiveSeries<Schema>, TimeSeries<Schema> | null] {
  const [live] = useState(() => new LiveSeries(options));

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onmessage = (ev) => {
        applyFrame(live, decode(ev.data as string));
      };
      ws.onclose = () => {
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      // onerror: do nothing. WS spec guarantees onclose fires after.
    };
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [url, live]);

  const snapshot = useSnapshot(live, hookOptions);
  return [live, snapshot];
}
