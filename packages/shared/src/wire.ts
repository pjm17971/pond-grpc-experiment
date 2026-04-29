import type { JsonRowForSchema } from 'pond-ts/types';
import type { Schema } from './schema.js';

/**
 * One row on the wire. Tuple form (`[time, cpu, requests, host]`)
 * matches `LiveSeries.toJSON()`'s default `rowFormat` and the shape
 * accepted by `LiveSeries.push(row)`.
 */
export type WireRow = JsonRowForSchema<Schema>;

/**
 * Snapshot frame: sent once on connect. The client bulk-pushes `rows`
 * into a fresh client-side `LiveSeries`.
 */
export type SnapshotMsg = { type: 'snapshot'; rows: WireRow[] };

/**
 * Append frame: one per aggregator-side `on('batch')` callback. The
 * client pushes `rows` into the same `LiveSeries` that received the
 * snapshot.
 */
export type AppendMsg = { type: 'append'; rows: WireRow[] };

export type WireMsg = SnapshotMsg | AppendMsg;

/**
 * Encode a wire message for transport. v1 ships JSON; the codec is
 * isolated here so a future MessagePack swap is a one-file change.
 * Callers (server `ws.send`, client `ws.onmessage`) only see the
 * serialized form, never `JSON.stringify` directly.
 */
export function encode(msg: WireMsg): string {
  return JSON.stringify(msg);
}

export function decode(raw: string): WireMsg {
  return JSON.parse(raw) as WireMsg;
}
