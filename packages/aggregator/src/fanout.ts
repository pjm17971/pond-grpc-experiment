import { performance } from 'node:perf_hooks';
import { type LiveSeries } from 'pond-ts';
import {
  type AppendMsg,
  type Schema,
  encode,
  schema,
} from '@pond-experiment/shared';
import { recordFanout, recordFanoutPhases } from './metrics.js';

/**
 * Subscribe to `live.on('batch', …)` and broadcast each batch as an
 * `append` frame. Returns the unsubscribe function.
 *
 * `Event.toJsonRow(schema)` (added in 0.11.4) does the per-column
 * serialization the schema dictates, so the fanout no longer hand-
 * walks columns and stays correct under schema evolution.
 *
 * Records both the ingest→fanout end-to-end latency (per event,
 * keyed against the arrival map) and the per-phase wall-clock
 * breakdown of the listener body — recordFanout loop, JSON
 * serialize, WS broadcast — so a `/metrics` consumer can attribute
 * the latency.
 */
export function startFanout(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
): () => void {
  return live.on('batch', (events) => {
    const t0 = performance.now();
    for (const e of events) {
      recordFanout(e.get('host'), e.key().timestampMs());
    }
    const tAfterRecord = performance.now();

    const rows = events.map((e) => e.toJsonRow(schema));
    const msg: AppendMsg = { type: 'append', rows };
    const frame = encode(msg);
    const tAfterSerialize = performance.now();

    broadcast(frame);
    const tAfterBroadcast = performance.now();

    recordFanoutPhases({
      recordMs: tAfterRecord - t0,
      serializeMs: tAfterSerialize - tAfterRecord,
      broadcastMs: tAfterBroadcast - tAfterSerialize,
    });
  });
}
