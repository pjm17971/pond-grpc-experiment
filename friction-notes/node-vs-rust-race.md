# Node vs Rust aggregator race (2026-10-28)

Step 4 of the revival. Both aggregators run the same pipeline: the 30 s
`/live` window with its WebSocket fan-out, plus the per-host
`/live-agg` stats (1 m baseline + 200 ms slice per host, anomaly
counts, globals). Node is pond-ts 0.75; Rust is pond-rs live
(partitions, R3 step 6). They produce the same `/live-agg` rows
(`pond-rs-live-agg.md`).

Setup: `packages/aggregator/scripts/race.sh 30 2` runs the
`bench:full` sweep (P hosts × N events/s per host), each config once
per aggregator back to back, two rounds, 30 s each after a 5 s warm-up.
The Rust producer feeds both, so the producer is never the limit
(main 2e2113d, with the bounded producer queue: rows an aggregator
can't take show as `Dropped/s`). Cloud container, 4 cores.

## Results

Two numbers per cell = the two rounds.

| P × N       | Target/s  | Node achieved/s | Rust achieved/s   | Node dropped/s    | Rust dropped/s    | Node CPU cores | Rust CPU cores | Node e2e p99 ms | Rust e2e p99 ms | Node peak MB | Rust peak MB |
| ----------- | --------- | --------------- | ----------------- | ----------------- | ----------------- | -------------- | -------------- | --------------- | --------------- | ------------ | ------------ |
| 10 × 1      | 10        | 10 / 10         | 10 / 10           | 0 / 0             | 0 / 0             | 0.01 / 0.01    | 0.00 / 0.00    | 8.81 / 3.93     | 0.29 / 0.30     | 32 / 24      | 7 / 7        |
| 10 × 10     | 100       | 100             | 100 / 100         | 0                 | 0 / 0             | 0.03           | 0.00 / 0.00    | 2.87            | 0.23 / 0.30     | 34           | 8 / 7        |
| 10 × 100    | 1,000     | 1,000 / 1,000   | 1,000 / 1,000     | 0 / 0             | 0 / 0             | 0.10 / 0.10    | 0.03 / 0.02    | 0.58 / 0.62     | 0.21 / 0.22     | 50 / 50      | 11 / 11      |
| 10 × 1000   | 10,000    | 9,983 / 9,902   | 10,009 / 10,001   | 6 / 90            | 3 / 0             | 0.75 / 0.73    | 0.13 / 0.13    | 1.58 / 0.81     | 0.38 / 0.21     | 276 / 272    | 44 / 43      |
| 100 × 1     | 100       | 100 / 100       | 100 / 99          | 0 / 0             | 0 / 0             | 0.02 / 0.02    | 0.00 / 0.00    | 5.00 / 6.29     | 1.29 / 3.53     | 32 / 33      | 9 / 9        |
| 100 × 10    | 1,000     | 1,002 / 999     | 1,000 / 999       | 0 / 0             | 0 / 0             | 0.06 / 0.06    | 0.01 / 0.01    | 3.12 / 3.13     | 1.17 / 1.40     | 59 / 58      | 17 / 17      |
| 100 × 100   | 10,000    | 9,999 / 9,997   | 10,000 / 9,991    | 0 / 0             | 0 / 0             | 0.28 / 0.27    | 0.06 / 0.06    | 2.08 / 1.65     | 1.29 / 1.62     | 222 / 229    | 51 / 51      |
| 100 × 1000  | 100,000   | 34,363 / 35,031 | 99,974 / 99,987   | 65,593 / 64,860   | 0 / 0             | 0.84 / 0.82    | 0.29 / 0.29    | 7.33 / 5.53     | 1.38 / 0.96     | 713 / 725    | 383 / 382    |
| 1000 × 1    | 1,000     | 996 / 996       | 997 / 997         | 0 / 0             | 0 / 0             | 0.04 / 0.05    | 0.01 / 0.01    | 12.17 / 19.16   | 10.01 / 8.16    | 83 / 77      | 30 / 30      |
| 1000 × 10   | 10,000    | 10,021 / 10,008 | 10,019 / 9,994    | 0 / 0             | 0 / 0             | 0.34 / 0.31    | 0.05 / 0.05    | 33.98 / 34.77   | 10.25 / 9.91    | 469 / 469    | 118 / 117    |
| 1000 × 100  | 100,000   | 34,732 / 34,538 | 99,942 / 99,939   | 65,199 / 65,528   | 0 / 0             | 0.95 / 0.99    | 0.42 / 0.44    | 7.58 / 14.73    | 25.49 / 26.61   | 862 / 947    | 449 / 444    |
| 1000 × 1000 | 1,000,000 | 34,357 / 34,131 | 231,863 / 237,275 | 966,663 / 966,339 | 768,011 / 762,663 | 0.97 / 0.95    | 1.04 / 1.04    | 26.24 / 26.23   | 26.03 / 25.47   | 1001 / 872   | 1047 / 1059  |

Columns:

- **CPU cores**: user + system CPU of the aggregator's processes over
  the 30 s, divided by 30 s (new `bench:dev` column, read from
  `/proc`). 1.0 = one core busy all the time.
- **Peak MB**: for Node the JS heap, for Rust the whole process (RSS),
  so Node's real footprint is higher than shown.
- One Node run (10 × 10, round 2) printed no result; two re-runs of
  that config gave 100 / 100 rows/s, 0.03 cores, 1.6–2.3 ms p99.
  `race.sh` now prints the tail of a failed run's output.

## What it says

- **Up to 10k rows/s both keep up.** Rust does it on 3–7x less CPU
  (10 × 1000: 0.13 vs 0.73–0.75 cores; 1000 × 10: 0.05 vs 0.31–0.34)
  and a quarter or less of the memory (even comparing Node's JS heap
  with Rust's whole process).
- **Node tops out at ~34–35k rows/s.** At every 100k config it is at
  one core (0.82–0.99) and drops ~65% of the stream. Rust takes all
  100k on 0.29–0.44 cores.
- **At 1M rows/s Rust takes 232–237k** on one core (1.04) and drops
  the rest. Its ingest runs on a single thread (gRPC read,
  `push_many`, `/live-agg` and the `/live` frame under one lock;
  sampled earlier, see `rust-producer.md`), so that's its ceiling
  here: ~7x Node.
- **Latency:** Rust's p99 is lower in most configs, about equal at
  1000 × 1000 (both saturated). Not at 1000 × 100:
  25–27 ms against Node's 7.6–14.7 ms, while Rust keeps up and Node
  drops 65% (so Node handles a third of the rows). I have not looked
  into where Rust's 26 ms goes; at 1000 hosts each 200 ms tick emits
  1000 rows.

On Peter's laptop (M1 Pro, main f80fd5d, before the bounded producer),
1000 × 1000: Rust 434–564k rows/s, Node 109–127k. The ratio
(~4–5x) is lower than here (~7x); I have not checked why.

## Not covered

- One machine; noise between batches here is ~15%, so differences
  under that between rows of this table mean little.
- Only the producer's own pattern: every host sends every tick, in
  time order. No late data, no gaps, no reconnects.
- Rust's 1000 × 100 p99 (above).
