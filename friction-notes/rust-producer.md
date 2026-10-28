# Rust producer (2026-10-28)

**Result: with a Rust producer the Rust aggregator takes 610–740k
rows/s (was capped at ~378k by the Node producer). The Rust aggregator
is now the limit: one thread near 100%.** The Node aggregator is
unchanged at 43–51k; it was never producer-bound.

## Why it was needed

At 1000 hosts × 1000/s with the Node producer and Rust aggregator,
sampled with `ps` during the run: Node producer 110–120% CPU (one JS
thread plus gRPC), Rust aggregator ~50%. So the Node producer set the
~370k rows/s ceiling seen in `pond-rs-live-window.md`.

## Bench (20 s, `bench:dev`, one batch)

| Producer | Aggregator | Load (P × N) | Achieved/s        | pushMany p99 ms | RSS / heap peak  |
| -------- | ---------- | ------------ | ----------------- | --------------- | ---------------- |
| Node     | Rust       | 1000 × 1000  | 377,872 / 378,748 | 4.09 / 3.93     | 741 MB           |
| Rust     | Rust       | 1000 × 1000  | 610,204 / 666,328 | 3.68 / 3.07     | 1,351 / 1,436 MB |
| Rust     | Rust       | 2000 × 1000  | 662,855           | 8.23            | 1,658 MB         |
| Rust     | Rust       | 4000 × 1000  | 740,834           | 19.31           | 1,621 MB         |
| Node     | Node       | 1000 × 1000  | 43,479            | 32.47           | 1,087 MB         |
| Rust     | Node       | 1000 × 1000  | 51,197            | 224.67          | 1,157 MB         |

Rust aggregator memory grows with rows held. A run is a 5 s warm-up
plus 20 s, so the 30 s window never fills: at ~650k/s it holds up to
~16M rows, about 85 bytes per row over the whole process.

The Rust → Node row (51k against a 1M target) is the Node aggregator's
limit, not the producer's: it falls behind and a backlog builds up in
the producer's per-subscriber queue, which is unbounded (as Node's
`call.write` ignores backpressure). Producer memory isn't measured by
the bench, so that backlog doesn't show in the table. (Since fixed:
both producers now keep at most 64 batches per subscriber and count
what they drop; `bench:dev` shows it as `Dropped/s`. See
`producer-backpressure.md`.)

## Where the Rust aggregator now spends its time

Sampled at 1000 × 1000 with the Rust producer: one aggregator thread
at 91–97% CPU, the other runtime threads ~9% each; producer 28%. The
gRPC read, `push_many`, the append frame and the broadcast all run on
the ingest task in turn, so the aggregator uses about one core. Not
profiled further yet; splitting frame writing off the ingest task is
the obvious next step if the race needs more.
