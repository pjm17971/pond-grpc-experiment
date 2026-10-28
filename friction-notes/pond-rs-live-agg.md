# `/live-agg` on pond-rs (2026-10-28)

Step 3b of the revival: the Rust aggregator now serves `/live-agg`, the
dashboard's per-host stats stream, on pond-rs R3 step 4 (#843: live
rolling, fused windows, clock triggers). pond-rs has no live partitions
yet (step 6), so the per-host split is done by hand: one small pond-rs
`LiveSeries` per host, each with the same fused rolling Node uses
(`1m`: cpu avg/stdev/count, requests avg/sum/count; `200ms`: cpu
samples/min/max/avg/stdev; `Trigger::clock` every 200 ms).

**Result: same rows as Node (checked side by side), and about 4.5–5x
Node's throughput with the full stats running: 227k rows/s against
43–51k.** At 1000 hosts the per-host step costs ~3.1 µs per row, 83%
of the aggregator's time.

## Same output as Node? (`scripts/compare-agg.ts`)

Both aggregators subscribe to one producer (20 hosts × 50/s, 75 s), so
they see the same events, and every `/live-agg` row is compared by
`ts` and host:

- Same rows (none only on one side), same field order.
- **First host of each batch: 374 of 374 rows identical, bit for
  bit.** The 200 ms fields are compared from the start; the rest (1 m
  baseline, anomaly counts) only once both have run a full minute
  (65 s), which leaves the last 50 rows compared whole, all 50
  identical. (`window_age_seconds` is left out; it counts from each
  aggregator's start.)
- `events_per_sec` (one rolling on the whole series in both): 365 of
  365 ticks identical, none missing in Rust.
- **Every other host: 7,106 rows, each with exactly one more event in
  Rust.** Before the 65 s mark only the 200 ms slice is compared, and
  it is +1 in all 6,156 rows; after it, the slice and the 1 m window
  are both +1 in all 950 rows. pond-ts 0.75
  `LivePartitionedFusedRolling.ingest` checks for a crossed boundary
  after each event and, on the first crossing, calls `#emitTick`,
  which emits every known partition at once. So the first host's event
  at the new time fires the tick before the other hosts' events at that
  same time are added. The hand split emits each host after its own
  event. Which is right is arguable; pond-rs step 6 will presumably
  copy pond-ts. Sent to the pond-rs live thread.
- Not exercised by this producer (every host sends every tick): in
  Node a host that goes quiet still gets a row each tick (`#emitTick`
  evicts its windows and emits them). Split by hand, a quiet host
  emits nothing until its next event.
- Late rows: a row for a host whose tick for that time already went
  out can't change it. Rust counts and drops these
  (`/metrics` → `aggregate.lateRowsDropped`); 0 in this run and in the
  benches, since the producer sends in time order.
- Number text: ordinary values print the same as JS. Very small or
  very large ones don't (`1e-7` prints `0.0000001`, `1e21` prints all
  22 digits) but read back to the same number. `-0` prints `-0` where
  JS prints `0`; the compare treats them as equal. None of these
  showed up in the run.

## Throughput (Rust producer, 20 s, alternated, one batch)

| Load (P × N) | Aggregator                | Achieved/s        | pushMany p99 ms | Peak memory      |
| ------------ | ------------------------- | ----------------- | --------------- | ---------------- |
| 100 × 1000   | Rust, `/live` only (main) | 99,933 / 100,080  | 0.30 / 0.18     | 200 / 201 MB     |
| 100 × 1000   | Rust + `/live-agg`        | 100,008 / 99,990  | 0.65 / 1.26     | 284 / 281 MB     |
| 1000 × 1000  | Rust, `/live` only (main) | 691,675 / 746,121 | 3.11 / 3.46     | 1,432 / 1,558 MB |
| 1000 × 1000  | Rust + `/live-agg`        | 227,007 / 226,616 | 13.41 / 10.39   | 727 / 717 MB     |

Node with the same work, earlier the same day (`rust-producer.md`):
43,479–51,197 rows/s at 1000 × 1000.

At 100 × 1000 both keep up with the producer. Memory is lower at
1000 × 1000 with `/live-agg` only because fewer rows got in.

## Where the time goes

A throwaway timing harness (the aggregator's own `Aggregate`, fed
in-process after a 60 s warm-up so the 1 m windows are full), ns per
row:

| Hosts | main series push | per-host push + rolling | ticks + frames | ceiling     |
| ----- | ---------------- | ----------------------- | -------------- | ----------- |
| 100   | 425              | 1,136                   | 9              | 637k rows/s |
| 1000  | 650              | 3,117                   | 34             | 263k rows/s |

The 1000-host ceiling (263k) matches the bench (227k, which also pays
gRPC and the `/live` frame). One host's series alone (warm cache):
550 ns per row one row per push, 449 ns at 100 rows per push; the
`samples` reducer is ~130–175 ns of that. So the cost per row grows
~3x from 100 to 1000 hosts: each host's window (60k events at 1000/s)
lives in its own memory, and each producer batch touches all 1000.

For step 6 (partitions): this producer sends one row per host per
batch, so batching rows per partition (as pond-ts #838 does) would not
help this load; the per-row cost of each host's rolling state is the
work.

## Other friction

- No live `sample({ stride })` in pond-rs yet; `SAMPLE_STRIDE` is a
  per-host counter here (keeps the Nth, 2Nth, …, as pond-ts).
- The fused rolling's `samples` column comes back as a list of
  `Scalar`s, converted to numbers here for the anomaly counts.
