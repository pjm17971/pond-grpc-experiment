# aggregator-rs

Rust version of `packages/aggregator`, for racing pond-rs against
pond-ts on the same gRPC stream. Same proto (`../shared/proto`), same
`/live` JSON frames (`../shared/src/wire.ts`), same `/metrics` shape,
same env (`AGGREGATOR_PORT`, `PRODUCER_URL`).

Building needs `protoc` (same as `pnpm codegen`).

```bash
cd packages/aggregator-rs && cargo build --release
AGGREGATOR_IMPL=rust pnpm --filter @pond-experiment/aggregator bench:dev --P=1000 --N=1000 --seconds=20
```

Status: `/live` (raw snapshot + appends), `/live-agg` (per-host rolling
stats every 200 ms, 5-minute snapshot, per-client top-N), `/health`,
`/metrics`. The 30 s window behind `/live` is a pond-rs `LiveSeries`
(pond-rs 0.1 from crates.io). `/live-agg` (`src/agg.rs`) runs
the same fused rolling as Node (1 m baseline + 200 ms slice, clock
trigger) on pond-rs live partitions (`partition_by("host")`, optional
per-host `sample`, `partition_rolling_windows`). Checked against Node
with `packages/aggregator/scripts/compare-agg.ts` (every row
identical); measured in `friction-notes/pond-rs-live-agg.md`.
`SAMPLE_STRIDE` works as in Node.

Not like Node: no GC (`gc` is `{}`); `memory.heapUsed` reports process
RSS, so the bench's "Heap peak" column compares Node's JS heap with
Rust's whole-process memory. A `/live` client more than 1024 frames
(or a `/live-agg` client more than 1024 ticks) behind is disconnected (Node has no limit), logged on stderr and counted
in `ws.clientsDropped`. The bench's `Probe MB/s` column shows what the
probe actually received and flags a disconnected probe.
