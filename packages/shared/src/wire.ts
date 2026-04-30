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
 * into a fresh client-side `LiveSeries`. `ReadonlyArray` because the
 * wire never mutates the rows after construction; consumers (notably
 * `LiveSeries.pushJson`) accept readonly inputs unchanged.
 */
export type SnapshotMsg = {
  type: 'snapshot';
  rows: ReadonlyArray<WireRow>;
};

/**
 * Append frame: one per aggregator-side `on('batch')` callback. The
 * client pushes `rows` into the same `LiveSeries` that received the
 * snapshot.
 */
export type AppendMsg = { type: 'append'; rows: ReadonlyArray<WireRow> };

/**
 * Per-host, per-tick aggregate row on the `/live-agg` stream. The
 * aggregator computes rolling 1m mean and sd from raw CPU samples it
 * ingested over gRPC, and emits one `HostTick` per host per tick on a
 * synchronized 200ms clock — every host's frame for tick `T` carries
 * the same `ts`. See `WIRE.md` at the repo root for the design.
 *
 * Step 1 of the M3.5 aggregate-wire work ships only the band-rendering
 * stats (`cpu_avg`/`cpu_sd`/`cpu_n`); the full target shape from
 * `WIRE.md` (anomaly counts, requests stats, min/max) is staged in
 * follow-ups.
 *
 * `cpu_avg` and `cpu_sd` are over the rolling 1m window; `cpu_n` is
 * the count of raw samples that arrived during this tick. Hosts with
 * no samples in the rolling window emit `cpu_avg`/`cpu_sd` as `null`
 * (the client treats this as a render gap).
 */
export type HostTick = {
  ts: number;
  host: string;
  cpu_avg: number | null;
  cpu_sd: number | null;
  cpu_n: number;
};

/**
 * Snapshot frame for `/live-agg`. Sent once on connect.
 *
 * - `thresholds` is the σ-threshold list anomaly density will use
 *   (deploy-time server config; default `[1, 1.5, 2, 2.5, 3]`). Step 1
 *   doesn't populate anomaly counts but ships the field so the client
 *   knows the buckets up front and the contract is forward-compatible.
 * - `rows` is the recent-history backfill. Step 1 ships an empty
 *   array — a connecting client fills the chart in as ticks arrive,
 *   trading first-paint coverage for protocol simplicity. Snapshot
 *   history lands when M4 measures whether the cost is real.
 */
export type AggregateSnapshotMsg = {
  type: 'aggregate-snapshot';
  thresholds: ReadonlyArray<number>;
  rows: ReadonlyArray<HostTick>;
};

/**
 * Append frame for `/live-agg`. One per 200ms tick. `rows` carries
 * one `HostTick` per host that had any samples in the rolling 1m
 * window at tick time; silent hosts are omitted (client renders the
 * column as a gap until the host re-appears).
 */
export type AggregateAppendMsg = {
  type: 'aggregate-append';
  rows: ReadonlyArray<HostTick>;
};

/**
 * Raw-event firehose message — the `/live` stream's frame shape.
 * Snapshot or append, both carrying `WireRow`s. Kept as a named alias
 * so `applyFrame` and friends can narrow on the raw side without
 * leaking the aggregate-stream variants into their type.
 */
export type RawWireMsg = SnapshotMsg | AppendMsg;

/**
 * Aggregate-tick message — the `/live-agg` stream's frame shape. See
 * `WIRE.md` for the design.
 */
export type AggregateWireMsg = AggregateSnapshotMsg | AggregateAppendMsg;

export type WireMsg = RawWireMsg | AggregateWireMsg;

/** Default σ-threshold list emitted in `AggregateSnapshotMsg.thresholds`. */
export const DEFAULT_AGGREGATE_THRESHOLDS: ReadonlyArray<number> = [
  1, 1.5, 2, 2.5, 3,
];

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
