import { type LiveSeries } from 'pond-ts';
import {
  type Schema,
  type SnapshotMsg,
  type WireRow,
} from '@pond-experiment/shared';

/**
 * Build a snapshot frame for a freshly-connected client. v1 calls
 * `live.toJSON()` per connect — M4 adds TTL caching when the
 * reconnect-storm test surfaces the cost.
 *
 * The cast to `WireRow[]` remains because `LiveSeries.toJSON()`'s
 * declared return type uses the wide `SeriesSchema` (not `<S>`), so
 * the rows come back as the broad `JsonRowForSchema<SeriesSchema> |
 * JsonObjectRowForSchema<SeriesSchema>` union. Narrowing on `<S>` is
 * the open typing item; once it lands the cast goes away.
 */
export function buildSnapshot(live: LiveSeries<Schema>): SnapshotMsg {
  const json = live.toJSON();
  return { type: 'snapshot', rows: json.rows as WireRow[] };
}
