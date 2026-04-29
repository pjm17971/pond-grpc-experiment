import { type LiveSeries } from 'pond-ts';
import {
  type AppendMsg,
  type Schema,
  type WireRow,
  encode,
} from '@pond-experiment/shared';

/**
 * Subscribe to `live.on('batch', …)` and broadcast each batch as an
 * `append` frame. Returns the unsubscribe function.
 *
 * The batch listener receives `EventForSchema[]` — runtime Event
 * objects, not the JSON tuple shape `toJSON()` returns. We serialize
 * per-column here. A library helper `eventsToJsonRows(events)` would
 * compress every aggregator's fanout to one line — friction-noted.
 */
export function startFanout(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
): () => void {
  return live.on('batch', (events) => {
    const rows: WireRow[] = events.map((e) => [
      e.key().timestampMs(),
      e.get('cpu'),
      e.get('requests'),
      e.get('host'),
    ]);
    const msg: AppendMsg = { type: 'append', rows };
    broadcast(encode(msg));
  });
}
