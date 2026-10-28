# `/live-agg` on pond-rs (2026-10-28)

Step 3b of the revival: the Rust aggregator now serves `/live-agg`, the
dashboard's per-host stats stream, on pond-rs live partitions (R3 step
6, #846): `partition_by("host")`, a per-host `sample` when
`SAMPLE_STRIDE` > 1, then `partition_rolling_windows` with the same
fused windows Node uses (`1m`: cpu avg/stdev/count, requests
avg/sum/count; `200ms`: cpu samples/min/max/avg/stdev;
`Trigger::clock` every 200 ms). A first version (before step 6) split
by host by hand, one small `LiveSeries` per host; its results are kept
below for comparison.

**Result: every row identical to Node when both see the same events
(checked side by side), and about 5x Node's throughput with the full
stats running: 233–239k rows/s against 43–51k.**

## Same output as Node? (`scripts/compare-agg.ts`)

Both aggregators subscribe to one producer (20 hosts × 50/s, 75 s), so
they see the same events once both have joined (see below), and every `/live-agg` row is compared by
`ts` and host. The 200 ms fields are compared from the start; the rest
(1 m baseline, anomaly counts) only once both have run a full minute
(65 s). `window_age_seconds` is left out; it counts from each
aggregator's start.

Six runs at stride 1 (each 7,500 host rows, 375 ticks):

| Runs | Both started from the same producer event? | Rows identical | Rows differing beyond last-bit rounding | `events_per_sec` |
| ---- | ------------------------------------------ | -------------- | --------------------------------------- | ---------------- |
| 3    | yes                                        | 7,500 / 7,500  | 0                                       | 365 / 365        |
| 3    | no (Rust joined the stream earlier)        | 7,164–7,244    | 0, 20, 20                               | 365 / 365        |

Plus one run with `SAMPLE_STRIDE=3`: 7,500 / 7,500 identical. Every run:
no rows only on one side, the same hosts in the same order in every
tick, same field order, no ticks missing in Rust.

When runs differ, the cause is the test setup, not the aggregators:
each one subscribes to the producer separately, and sometimes Rust
gets one or two producer ticks (20 ms each) before Node does. Its first
`/live-agg` tick then holds those extra events (`n_current` 6 vs 5,
`window_age_seconds` 0.097 vs 0.076): those are the 20 rows, one tick
of 20 hosts. After that the only differences are in the last digits of
`current_sd` and `cpu_sd` (within 1e-12 of each other): the rolling
standard deviation keeps running sums, and an event that was added and
later removed leaves slightly different rounding behind. `compare-agg`
reports `sameFirstEvent` and counts the rounding-only rows separately.

The hand-split version matched only the first host of each batch.
Every other host held exactly one more event in Rust (in all 7,106
rows; in the 1 m window too, once settled). pond-ts 0.75
`LivePartitionedFusedRolling.ingest` emits every known partition as
soon as the first host's event crosses a boundary, before the other
hosts' events at that time are added; the hand split emitted each host
after its own event. pond-rs partitions copy pond-ts (and also emit a
quiet host each tick, as Node does), so both differences are gone.

Not compared: snapshot frames and the globals field order.

Number text: ordinary values print the same as JS. Very small or very
large ones don't (`1e-7` prints `0.0000001`, `1e21` prints all 22
digits) but read back to the same number. `-0` prints `-0` where JS
prints `0`; the compare treats them as equal. None showed up in the
runs.

## Throughput (Rust producer, 20 s, alternated, one batch)

Partitions against the hand split, same batch:

| Load (P × N) | `/live-agg` built with | Achieved/s        | pushMany p99 ms | Peak memory  |
| ------------ | ---------------------- | ----------------- | --------------- | ------------ |
| 100 × 1000   | hand split             | 99,922 / 99,933   | 1.76 / 0.87     | 289 / 283 MB |
| 100 × 1000   | pond-rs partitions     | 100,041 / 99,923  | 1.55 / 0.90     | 286 / 282 MB |
| 1000 × 1000  | hand split             | 197,396 / 189,608 | 14.44 / 13.79   | 667 / 651 MB |
| 1000 × 1000  | pond-rs partitions     | 233,399 / 238,618 | 8.51 / 8.61     | 744 / 759 MB |

At 1000 hosts partitions are ~20% faster with ~40% lower p99. Memory is
higher because more rows got in. I have not profiled where the gain
comes from.

Earlier batch (hand split, against the aggregator without `/live-agg`):

| Load (P × N) | Aggregator                | Achieved/s        | pushMany p99 ms | Peak memory      |
| ------------ | ------------------------- | ----------------- | --------------- | ---------------- |
| 100 × 1000   | Rust, `/live` only (main) | 99,933 / 100,080  | 0.30 / 0.18     | 200 / 201 MB     |
| 100 × 1000   | Rust + `/live-agg`        | 100,008 / 99,990  | 0.65 / 1.26     | 284 / 281 MB     |
| 1000 × 1000  | Rust, `/live` only (main) | 691,675 / 746,121 | 3.11 / 3.46     | 1,432 / 1,558 MB |
| 1000 × 1000  | Rust + `/live-agg`        | 227,007 / 226,616 | 13.41 / 10.39   | 727 / 717 MB     |

The hand split measured 227k there and 190–197k in the batch above:
batches on this machine differ by ~15%, so compare within a batch.
Node with the same work (`rust-producer.md`): 43,479–51,197 rows/s at
1000 × 1000.

## Where the time goes (hand split)

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

## Other friction

- `sample` per partition goes through `per_partition` with a closure
  (pond-ts: `partitionBy('host').sample({ stride })`). It works; it is
  more to write than the pond-ts chain.
- The fused rolling's `samples` column comes back as a list of
  `Scalar`s, converted to numbers here for the anomaly counts.
