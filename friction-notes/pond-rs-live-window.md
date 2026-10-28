# pond-rs `LiveSeries` behind `/live` (2026-10-28)

Step 3a of the revival: the Rust aggregator's 30 s window moved from a
plain `VecDeque` of gRPC events to a pond-rs `LiveSeries` (R3 step 2,
pond-ts/pond #839, rev `3792442`). Same schema and retention as the
Node side (`maxAge: '30s'`, strict order).

**Result: same throughput, a slower batch handler (p99 1.7–2.6x at
1000 × 1000, 9–14x at 100 × 1000 where it is under 1.3 ms either way),
and 3.7x the memory.** The memory is the finding worth acting on.

## Bench (20 s, alternated, same batch)

`bench:dev` with `AGGREGATOR_IMPL=rust`. Achieved rows/s is set by the
producer at these loads (both versions near 345–356k at 1000 × 1000),
so it does not separate them.

| Load        | Window         | Achieved/s | pushMany p99 ms | serialize p99 ms | RSS peak |
| ----------- | -------------- | ---------- | --------------- | ---------------- | -------- |
| 100 × 1000  | VecDeque run 1 | 87,850     | 0.09            | 0.08             | 174 MB   |
| 100 × 1000  | pond-rs run 1  | 87,190     | 0.83            | 0.44             | 660 MB   |
| 100 × 1000  | VecDeque run 2 | 86,812     | 0.09            | 0.08             | 187 MB   |
| 100 × 1000  | pond-rs run 2  | 86,921     | 1.23            | 0.54             | 642 MB   |
| 1000 × 1000 | VecDeque run 1 | 356,251    | 2.03            | 1.26             | 691 MB   |
| 1000 × 1000 | pond-rs run 1  | 343,250    | 5.22            | 1.81             | 2,539 MB |
| 1000 × 1000 | VecDeque run 2 | 350,012    | 3.34            | 2.12             | 676 MB   |
| 1000 × 1000 | pond-rs run 2  | 346,024    | 5.66            | 1.71             | 2,545 MB |

The probe stayed connected in every run (Probe MB/s 3.9–16.4, matching
row rates). `pushMany p99` here is the whole batch handler: push,
serialize, broadcast.

## Why the memory

At 1000 × 1000 the window holds about 345k × 30 ≈ 10.3M rows:
2,539 MB / 10.3M ≈ 250 bytes per row in pond-rs, against
691 MB / 10.3M ≈ 67 bytes in the queue. Both are peak process memory
over rows, so they include fixed costs; the difference, **about 180
bytes per row**, is the cleaner number.

pond-rs R3 step 2 stores each event as its own heap object
(`LiveEvent` = `Arc<EventData { key, values: Vec<Option<Value>> }>`).
`Option<Value>` is 48 bytes (measured with `size_of`; `Value` carries a
`Decimal` and `Array` variant), so three cells are 144 bytes in their
own allocation, plus the `Arc` block (counts, key, `Vec` header), plus
the host `String`. The queue holds the gRPC struct inline (f64, i64,
i64, `String`).

pond-rs #839 already notes a column store as the fix for its
`push_many` cost; this is the same cause showing up as memory. Passed to
the pond-rs live-layer thread as friction.

## Update: column storage (pond-ts/pond #842)

pond-rs fixed the memory finding in #842 (live events stored by column).
This PR now pins that rev (`99934b2`). The one API change was that
`events()` now gives owned events, so `wire::snapshot_frame` takes them
by value. Re-run, all three alternated in one batch (20 s each):

| Load        | Window       | Achieved/s        | pushMany p99 ms | RSS peak         |
| ----------- | ------------ | ----------------- | --------------- | ---------------- |
| 100 × 1000  | VecDeque     | 86,084 / 87,464   | 0.43 / 0.09     | 189 / 173 MB     |
| 100 × 1000  | pond-rs #839 | 86,890 / 85,926   | 1.30 / 1.60     | 729 / 633 MB     |
| 100 × 1000  | pond-rs #842 | 85,812 / 85,627   | 0.21 / 0.18     | 171 / 170 MB     |
| 1000 × 1000 | VecDeque     | 372,957 / 365,590 | 4.90 / 3.49     | 727 / 704 MB     |
| 1000 × 1000 | pond-rs #839 | 318,316 / 335,784 | 8.21 / 9.24     | 2,400 / 2,503 MB |
| 1000 × 1000 | pond-rs #842 | 387,994 / 374,094 | 4.05 / 4.53     | 755 / 735 MB     |

**With #842 the pond-rs window costs about the same as the plain
queue:** memory within 5%, batch p99 inside the queue's own run-to-run
spread, throughput the same (producer-bound). The tables above this
section describe #839 and are kept as the record of the finding.

## Behaviour change: bad batches

The queue wrote a non-finite `cpu` as `null`. The `LiveSeries` has
`cpu` required (as the Node schema does), and pond-rs reads NaN/±Inf
as missing, so such a batch is refused whole and sends no append frame.
Node does the same (its `pushMany` throws). The simulator never sends
one. Refusals are counted in `/metrics` as `pushMany.refusedBatches`;
only the first is logged.

## Other friction

- `to_json` on a `LiveSeries` copies the window into a `TimeSeries` and
  returns one JSON value; there is no way to write rows to a text buffer
  as they are read. The snapshot frame here walks `live.events()` and
  writes text directly instead (`src/wire.rs`).
- No other friction: schema, retention, `watch`, and `Output::Batch`
  mapped onto the Node code one to one.
