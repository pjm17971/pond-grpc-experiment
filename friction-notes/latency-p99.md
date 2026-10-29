# Why Rust's "e2e p99" looked worse than Node's at 1000 × 100

_gRPC experiment agent (Claude), 2026-10-29._

The race (`node-vs-rust-race.md`) showed Rust's `e2e p99` at 25–27 ms
against Node's 7.6–14.7 ms at 1000 hosts × 100 events/s, although Rust
kept up and Node dropped 65% of the stream. Rust is not slower. The
two aggregators measured different things.

## What each one measured

Both report `latency.ingestToFanoutMs`, kept in a ring of the last
1024 samples:

|                                               | Node                                                                        | Rust                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Clock starts                                  | gRPC batch callback (per event)                                             | gRPC batch callback                                                              |
| Clock stops                                   | start of the `/live` batch listener, **before** the frame is built and sent | end of the batch: `/live` frame sent **and** any `/live-agg` tick built and sent |
| `/live-agg` tick work                         | not counted (it runs in a microtask after `pushMany`)                       | counted                                                                          |
| Samples                                       | one per **event**                                                           | one per **batch**                                                                |
| What the 1024-sample ring holds at 1000 hosts | about the last 1 batch                                                      | the last ~10 s of batches                                                        |

So Node's number is the latency of roughly the one batch before the
final scrape, with the slow parts left out. Rust's is a real p99 over
10 s that includes the slow parts. That's also why Node's figure
jumps around: in today's re-run it read 386–532 ms.

## Same rule for both: `batchDoneMs`

New metric in both aggregators, new `Batch done p50 / p99` columns in
`bench:dev`: per gRPC batch, from the batch callback to the end of all
work the batch causes (`/live` frame sent, and any `/live-agg` tick
built and sent). One sample per batch. Node stops the clock in a
microtask queued after `pushMany`, which runs after the aggregator's
own tick microtask.

1000 × 100, Rust producer, 30 s, two rounds alternating (cloud
container, 4 cores; this machine was busier than during the race:
Rust used 0.71–0.72 cores here against 0.42–0.44 then):

|      | Achieved/s | Dropped/s | CPU cores | Batch done p50 ms | Batch done p99 ms | old `e2e p99` ms |
| ---- | ---------- | --------- | --------- | ----------------- | ----------------- | ---------------- |
| Node | 27,446     | 72,577    | 1.18      | 22.24             | 79.04             | 532.47           |
| Rust | 100,013    | 0         | 0.72      | 6.32              | 21.92             | 21.92            |
| Node | 28,629     | 71,505    | 1.08      | 22.06             | 65.52             | 386.12           |
| Rust | 99,965     | 0         | 0.71      | 6.37              | 21.36             | 21.36            |

Measured the same way, Rust's batches are about 3.5x faster at p50
and 3x at p99, while it handles 3.5x the rows. `e2e p99` is left in
the table for history; use `Batch done` to compare the two.

## Where Rust's 21 ms p99 goes

Split with temporary timers (not committed), live run, 1000 × 100:

| Rust batch                                                | p50 ms  | p99 ms |
| --------------------------------------------------------- | ------- | ------ |
| Plain batch (19 of 20)                                    | 5.3–5.9 | 10–12  |
| Batch that crosses a 200 ms tick (1 in 20)                | 15      | 25–29  |
| of which `push_many`                                      | 4.7–6   | 12–15  |
| of which building + sending the 1000-row `/live-agg` tick | 2.7     | 5–6    |

A batch arrives every 10 ms with 1000 rows. One in 20 crosses a
200 ms tick, so 5% of batches carry the tick work; that sets the p99.
On a tick batch, `push_many` also emits 1000 per-host rolling rows
(1 m and 200 ms windows), and the aggregator turns them into the
`/live-agg` frame.

Offline (same pipeline, synthetic batches, no network): `push_many`
5.4 ms per plain 1000-row batch, 10.6 ms on a tick batch; the tick
frame 2.5 ms. A callgrind profile of 200 batches shows no single hot
spot. `push_many` is 63% of instructions; inside it, the per-host
partitions take 38%, of which the per-host rolling is 23%.
malloc/free is about a fifth of everything. Most of the rest is the
aggregator's own JSON: the `/live` frame is ~19% of instructions but
only ~0.5 ms of time.

Bumping pond-rs from `db9fe1a` (#846) to `2adef38` (#852 "less work
per event", #853) moved these 3–5%, inside this machine's noise.
This PR keeps the bump.

## Not done

- No change to pond-rs. Its per-event cost is the live speed review's
  ground (pond `[PND-RUSTLIVEBATCH]` is the open item there).
- Tick work could leave the batch path (build the `/live-agg` frame
  outside the lock, or on another task) to cut the p99. Not tried: it
  changes what a client taking a snapshot sees and Node doesn't do it.
