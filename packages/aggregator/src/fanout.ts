import { type LiveSeries } from 'pond-ts';
import {
  type AppendMsg,
  type Schema,
  encode,
  schema,
} from '@pond-experiment/shared';

/**
 * Subscribe to `live.on('batch', …)` and broadcast each batch as an
 * `append` frame. Returns the unsubscribe function.
 *
 * `Event.toJsonRow(schema)` (added in 0.11.4) does the per-column
 * serialization the schema dictates, so the fanout no longer hand-
 * walks columns and stays correct under schema evolution.
 */
export function startFanout(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
): () => void {
  return live.on('batch', (events) => {
    const rows = events.map((e) => e.toJsonRow(schema));
    const msg: AppendMsg = { type: 'append', rows };
    broadcast(encode(msg));
  });
}
