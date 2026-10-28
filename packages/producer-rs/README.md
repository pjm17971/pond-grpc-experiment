# producer-rs

Rust version of `packages/producer`: same simulator (per-host baseline,
slow walk, anomaly bursts, noise), same `Subscribe` stream on
`../shared/proto/events.proto`, same env vars (`GRPC_PORT`,
`EVENTS_PER_SEC` per host, `HOST_COUNT`, `VARIABILITY`).

```bash
cd packages/producer-rs && cargo build --release
PRODUCER_IMPL=rust AGGREGATOR_IMPL=rust pnpm --filter @pond-experiment/aggregator bench:dev --P=1000 --N=1000 --seconds=20
```

Why: the Node producer is one JS thread and tops out near 370k events/s
here, so it hid how fast the Rust aggregator is. Numbers in
`friction-notes/rust-producer.md`.

Not like Node, on purpose:

- A late tick is made up, so the rate holds at the target; Node's
  `setInterval` drifts and cannot tick faster than every 1 ms.
- Random numbers come from a small xorshift, not `Math.random`: same
  distributions, different values.
- With no subscriber connected the simulator does not run (Node runs
  it anyway and throws the batches away).
