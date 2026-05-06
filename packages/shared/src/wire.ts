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
 * aggregator runs one fused multi-window partitioned rolling (pond
 * 0.15.0+) — a 1m baseline window producing `cpu_avg`/`cpu_sd`/
 * `cpu_n` and `requests_avg`/`requests_sum`/`requests_n`, and a
 * 200ms leading-edge slice producing `n_current` and the anomaly
 * arrays — and emits one `HostTick` per host per tick on the same
 * `ts`. See `WIRE.md` at the repo root for the design and the
 * dashboard side's rendering contract.
 *
 * Field semantics:
 *
 * - `cpu_avg`, `cpu_sd` — over the 1m baseline window. Nullable: pond
 *   may emit undefined stats for an empty rolling window in some
 *   policies; the wire passes the gap through.
 * - `cpu_n` — sample count in the 1m baseline window (the bucket
 *   count, not per-tick). Drives the consumer's render gate ("are
 *   the stats backed by enough samples?").
 * - `n_current` — sample count in the most recent 200ms slice. The
 *   denominator for "what fraction of *now* is anomalous?".
 * - `anomalies_above[i]` — count of samples in the current slice
 *   whose value exceeds `cpu_avg + thresholds[i] * cpu_sd`. Length
 *   equals the snapshot's `thresholds` array; the dashboard
 *   interpolates linearly between buckets for the user's σ slider
 *   value. Empty `[]` when `cpu_avg`/`cpu_sd` are null (gating
 *   condition for anomaly counting).
 * - `anomalies_below[i]` — same idea, below the band.
 * - `requests_avg` — over the 1m baseline window. Nullable for the
 *   same reason as `cpu_avg`.
 * - `requests_sum` — sum of `requests` over the 1m baseline window.
 *   Total request volume the host fielded in the rolling minute.
 *   Defaults to 0 for an empty bucket (not null — sum-of-empty is 0).
 * - `requests_n` — sample count in the 1m baseline window. Same
 *   semantics as `cpu_n` but for the `requests` column. In practice
 *   `cpu_n` and `requests_n` track each other since both come from
 *   the same source events; kept separate so a future producer that
 *   emits sparse-`requests` events doesn't desync the gating.
 * - `window_age_seconds` — elapsed wall-clock seconds covered by
 *   this row's rolling window, capped at the window length (60s for
 *   the 1m baseline). During the aggregator's first 60s of operation
 *   this is the actual data-window-so-far; once warm it pins to 60.
 *   Lets the dashboard divide rolling sums (e.g. `requests_sum`) by
 *   the *real* elapsed window rather than a hardcoded 60s, so
 *   request-rate displays don't show a 60s diagonal warmup ramp on
 *   a freshly-started aggregator. Same value across hosts at a
 *   given tick — repeated per row for self-describing chart history.
 */
export type HostTick = {
  ts: number;
  host: string;
  cpu_avg: number | null;
  cpu_sd: number | null;
  cpu_n: number;
  n_current: number;
  anomalies_above: ReadonlyArray<number>;
  anomalies_below: ReadonlyArray<number>;
  requests_avg: number | null;
  requests_sum: number;
  requests_n: number;
  window_age_seconds: number;
};

/**
 * Per-tick **global** stats on the `/live-agg` stream — properties
 * of the aggregator itself, not of any individual host. Step 6 of
 * M3.5 surfaces these so the dashboard's headline numbers reflect
 * the **gRPC firehose** (true ingest rate + cumulative event count
 * since aggregator start), not the dashboard's down-scaled local
 * view of `/live-agg`. The dashboard reader should believe they're
 * looking at the raw stream; the aggregate-frame compression is an
 * implementation detail surfaced separately as "experiment stats".
 *
 * Field semantics:
 *
 * - `events_ingested_total` — cumulative number of raw events the
 *   aggregator has consumed off the producer's gRPC stream since
 *   aggregator start. Monotonic; survives client reconnect.
 * - `events_per_sec` — count of raw events seen in the trailing 1s
 *   window at tick time. Computed by a non-partitioned pond rolling
 *   sharing the same `Trigger.clock(seq)` as the per-host fused
 *   rolling, so globals and host frames emit on the same boundaries.
 * - `evicted_total` — cumulative number of events the LiveSeries
 *   retention policy has evicted since aggregator start. Useful for
 *   spotting "we're behind on backpressure" silently.
 *
 * One frame per tick (alongside the per-host rows). Optional on
 * `AggregateAppendMsg` for forward-compat with pre-step-6 servers
 * during deploys; once step 6 lands fully it's always present.
 */
export type GlobalsTick = {
  ts: number;
  events_ingested_total: number;
  events_per_sec: number;
  evicted_total: number;
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
 * - `globals` is a tail of the most recent globals ticks (history
 *   parallel to `rows`). Step 6 ships either an empty array or the
 *   single most-recent tick; full backfill arrives with snapshot
 *   history (step 8). Optional for forward-compat.
 */
export type AggregateSnapshotMsg = {
  type: 'aggregate-snapshot';
  thresholds: ReadonlyArray<number>;
  rows: ReadonlyArray<HostTick>;
  globals?: ReadonlyArray<GlobalsTick>;
};

/**
 * Append frame for `/live-agg`. One per 200ms tick. `rows` carries
 * one `HostTick` per host that had any samples in the rolling 1m
 * window at tick time; silent hosts are omitted (client renders the
 * column as a gap until the host re-appears). `globals` carries the
 * tick's aggregator-wide counters (step 6+); a single object since
 * append is per-tick. Optional during step-6 rollout.
 */
export type AggregateAppendMsg = {
  type: 'aggregate-append';
  rows: ReadonlyArray<HostTick>;
  globals?: GlobalsTick;
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
