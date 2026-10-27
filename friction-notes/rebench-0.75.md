# Re-bench on pond-ts 0.75 (2026-10-27)

First step of reviving the experiment (next: a Rust aggregator on
`pond-rs`, see the plan in the pond-ts project thread). The repo moved
from pond-ts 0.17.0 to 0.75.0 and the aggregator was re-measured.

**Result: the aggregator is 15–33% slower on 0.75 than on 0.17 at
the loads that push it, and the drop comes from one release, 0.20.0.**

## Machine

Cloud container, 4 cores, 15 GB RAM, Node 22.22. Slower than the
laptop the V1–V5 numbers came from, so only same-machine numbers below
are compared. The old ~210k rows/s ceiling is not comparable.

## Upgrade friction (both small)

- `aggregate.ts`: `const fused: LiveSource<SeriesSchema> = …rolling(…)`
  no longer type-checks. A fused rolling whose window name is a plain
  `string` (here `` `${tickMs}ms` ``) gets an output column kind of
  `'time' | ScalarKind`, which is not a `ValueColumn`. With literal window
  names it still type-checks. Fix here: drop the annotation (nothing
  needed the wide type). Worth a look on the pond-ts side: building a
  window name from a number is normal.
- `useRemoteLiveSeries.test.ts`: the required-column error now reads
  `row 0 col 1 (cpu) is required` (was `column 'cpu' is required`). Test
  regex updated.

All 113 tests pass on 0.75.

## `pnpm perf`, two runs per version (30 s windows)

Rows/s the aggregator ingested (hosts × events/s per host):

| Load | 0.17.0 run 1 | 0.17.0 run 2 | 0.75.0 run 1 | 0.75.0 run 2 | change |
| --- | --- | --- | --- | --- | --- |
| 100 × 100 | 9,748 | 9,765 | 9,692 | 9,737 | none (not under pressure) |
| 100 × 1000 | 69,315 | 72,808 | 58,917 | 61,259 | about −15% |
| 1000 × 100 | 70,666 | 70,808 | 51,318 | 52,641 | about −26% |
| 1000 × 1000 | 58,762 | 57,845 | 37,800 | 39,088 | about −33% |

Heap peak at 1000 × 1000: 949–1151 MB on 0.17, 535–542 MB on 0.75.

## Which release (20 s windows, one batch)

| pond-ts | 1000 × 100 rows/s | 1000 × 1000 rows/s |
| --- | --- | --- |
| 0.17.1 | 76,744 | 69,582 |
| 0.18.0 | 80,697 | 70,780 |
| 0.19.0 | 80,840 | 68,145 |
| **0.20.0** | **64,679** | **54,442** |
| 0.30.0 | 57,645 | 48,527 |
| 0.50.0 | 60,908 | 53,711 |
| 0.75.0 | 59,251 | 49,787 |

0.19 vs 0.20 at 1000 × 1000, alternated three times: 0.19 = 72,280 /
71,394 / 74,801; 0.20 = 57,021 / 55,091 / 59,106. **About −22%, well
outside the run-to-run spread.** Absolute numbers move ~15% between
batches run at different times, so compare within a table only.

Heap peak at this cell is too noisy run to run (0.19: 693–1105 MB) to
claim a memory win from 0.20 alone; the 0.17 vs 0.75 `pnpm perf` runs
above do show about half.

## Why (CPU profile, 1000 × 1000, 20 s)

0.20.0 is column-native partition routing (pond-ts #175). In
`LivePartitionedSeries.#routeChunk`, each row of an incoming batch is
handed to its host's sub-series **one row at a time**
(`part._stageRows(store, [i])`). Each call does an order check (two
`beginAt` reads), a write into the column store, builds one `Event`,
runs retention, and dispatches a one-row `'batch'`. New self-time lines
on 0.75: `_stageRows`, `stageRows`, `beginAt` ×2,
`materializeEventsFromStoreAt`, `validateAndNormalizeColumnar`,
`#locate`, about 2.4 s of 20 s. The rolling maths (`rolling.js add`,
`#advanceAndAddPartition`) costs about the same in both.

Row by row is deliberate (code comment): routing host by host would
send events out of time order and break a strict `collect()` fan-in. A
fix could keep the source-order event fan-out but do the storage write
and retention once per host per batch.

#175 was measured on one long-retention memory cell (100 hosts ×
700 events/s × 90 s retention: +24% throughput, −13.5% memory). These
short-retention, many-host cells were not re-run at the time.
