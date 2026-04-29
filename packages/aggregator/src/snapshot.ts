import { type LiveSeries } from 'pond-ts';
import {
  type Schema,
  type SnapshotMsg,
  type WireRow,
} from '@pond-experiment/shared';

/**
 * Build a snapshot frame for a freshly-connected client. v1 calls
 * `live.toTimeSeries().toJSON()` per connect — the two-step ensures
 * the snapshot is taken at a consistent moment, immune to concurrent
 * pushes. M4 adds TTL caching when the reconnect-storm test surfaces
 * the cost.
 *
 * The cast to `WireRow[]` is justified because the default
 * `rowFormat` of `toJSON()` is the tuple form — same shape as
 * `WireRow`. (`toJSON()`'s static return type is the broader union
 * `JsonRowForSchema | JsonObjectRowForSchema`; a narrowing overload
 * keyed on `rowFormat` would remove this cast — friction-noted.)
 */
export function buildSnapshot(live: LiveSeries<Schema>): SnapshotMsg {
  const json = live.toTimeSeries().toJSON();
  return { type: 'snapshot', rows: json.rows as WireRow[] };
}
