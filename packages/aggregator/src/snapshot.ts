import { type LiveSeries } from 'pond-ts';
import {
  type Schema,
  type SnapshotMsg,
} from '@pond-experiment/shared';

/**
 * Build a snapshot frame for a freshly-connected client. v1 calls
 * `live.toJSON({ rowFormat: 'array' })` per connect — M4 adds TTL
 * caching when the reconnect-storm test surfaces the cost.
 *
 * The 0.11.6 narrowing on `rowFormat` returns
 * `TimeSeriesJsonOutputArray<S>` directly, so `json.rows` is
 * `JsonRowForSchema<S>[]` (= `WireRow[]` for our schema) — no cast.
 */
export function buildSnapshot(live: LiveSeries<Schema>): SnapshotMsg {
  const json = live.toJSON({ rowFormat: 'array' });
  return { type: 'snapshot', rows: json.rows };
}
