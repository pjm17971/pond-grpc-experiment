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
(pinned by git rev in `Cargo.toml`). `/live-agg` (`src/agg.rs`) runs
the same fused rolling as Node (1 m baseline + 200 ms slice, clock
trigger), but split by host by hand, one small pond-rs series per host,
until pond-rs has live partitions (R3 step 6). Checked against Node
with `packages/aggregator/scripts/compare-agg.ts`; measured in
`friction-notes/pond-rs-live-agg.md`. `SAMPLE_STRIDE` works as in Node.

Not like Node: hosts other than the first in a batch emit their tick
after their own event at that time arrives (Node's partitions all emit
when the first host's event crosses the tick), so their `/live-agg` rows
hold one more event; a host that goes quiet stops getting rows (Node
keeps emitting it). Both come from the hand split, not pond-rs. No GC (`gc` is `{}`); `memory.heapUsed` reports process
RSS, so the bench's "Heap peak" column compares Node's JS heap with
Rust's whole-process memory. A `/live` client more than 1024 frames
(or a `/live-agg` client more than 1024 ticks) behind is disconnected (Node has no limit), logged on stderr and counted
in `ws.clientsDropped`. The bench's `Probe MB/s` column shows what the
probe actually received and flags a disconnected probe.
