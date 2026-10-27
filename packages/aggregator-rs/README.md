# aggregator-rs

Rust version of `packages/aggregator`, for racing pond-rs against
pond-ts on the same gRPC stream. Same proto (`../shared/proto`), same
`/live` JSON frames (`../shared/src/wire.ts`), same `/metrics` shape,
same env (`AGGREGATOR_PORT`, `PRODUCER_URL`).

```bash
cd packages/aggregator-rs && cargo build --release
AGGREGATOR_IMPL=rust pnpm --filter @pond-experiment/aggregator bench:dev --P=1000 --N=1000 --seconds=20
```

Status: **shell only.** `/live` (raw snapshot + appends), `/health`,
`/metrics`. The 30 s window behind the snapshot is a `VecDeque`, to be
replaced by a pond-rs `LiveSeries` when pond-rs R3 step 2 lands.
`/live-agg` (per-host rolling stats every 200 ms) is not built; it needs
R3 steps 4-6 (rolling, triggers, partitions).

Not like Node: no GC (`gc` is `{}`); `memory.heapUsed` reports process
RSS. A `/live` client more than 1024 frames behind is disconnected (Node
has no limit).
