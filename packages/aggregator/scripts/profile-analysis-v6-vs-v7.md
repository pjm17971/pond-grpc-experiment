# Profile diff — V6 (manual deque) vs V7 (samples reducer)

Captured at the ceiling regime (`--P=1000 --N=1000 --seconds=20`) with
`profile-agg.ts`. Both runs lasted ~20.3s and recorded ~32.4k samples,
so percentage comparisons are apples-to-apples. V6 uses pond 0.14.0,
V7 uses pond 0.14.2 (+ the new `samples` built-in reducer).

Reproducer: see `pnpm perf` for the V7 run; for V6 check out commit
`a030c6c` in a worktree, copy the generated `packages/shared/src/grpc/events.ts`
across (it's git-ignored), and run
`pnpm --filter @pond-experiment/aggregator exec tsx scripts/profile-agg.ts --P=1000 --N=1000 --seconds=20 --profDir=/tmp/agg-prof-v6`.

## Bench-side numbers (already in the PR #18 body)

| Config           | V6 heap | V7 heap | Δ       |
| ---------------- | ------- | ------- | ------- |
| 9k/s             | 161 MB  | 147 MB  | **−9%** |
| 87k/s            | 1617 MB | 1886 MB | +17%    |
| 92k/s × 1k hosts | 1379 MB | 1426 MB | +3%     |

Ceiling throughput: V6 258k/s → V7 209k/s (**−19%**).

## What the profiles say

### Self-time-by-script — the headline

| Script                                         | V6 self     | V7 self     | Δ             |
| ---------------------------------------------- | ----------- | ----------- | ------------- |
| `pond-ts/dist/LivePartitionedSyncRolling.js`   | 8.3%        | **20.7%**   | **+12.4 pp**  |
| `pond-ts/dist/LiveSeries.js`                   | 5.9%        | 7.1%        | +1.2 pp       |
| `pond-ts/dist/reducers/samples.js`             | —           | 2.3%        | NEW           |
| `pond-ts/dist/reducers/avg.js`                 | 0.3%        | 0.7%        | +0.4 pp       |
| `aggregator/src/aggregate.ts` (user code)      | **2.3%**    | **0.3%**    | **−2.0 pp**   |
| `aggregator/src/metrics.ts`                    | 8.6%        | 7.2%        | −1.4 pp       |
| `shared/src/wire.ts`                           | 7.9%        | 5.8%        | −2.1 pp       |
| `pond-ts/dist/Event.js`                        | 4.8%        | 3.8%        | −1.0 pp       |
| `(garbage collector)`                          | 37.5%       | 33.4%       | −4.1 pp       |

### Top self-time call sites

| Call site                                           | V6 self     | V7 self     | Δ          |
| --------------------------------------------------- | ----------- | ----------- | ---------- |
| `LivePartitionedSyncRolling.ingest` (line 197/210)  | 7.6%        | **9.7%**    | +2.1 pp    |
| `LivePartitionedSyncRolling.#evictPartition`        | not top-25  | **8.8%**    | NEW        |
| `LivePartitionedSyncRolling.#ensurePartition`       | 0.5%        | 2.0%        | +1.5 pp    |
| `LiveSeries.#validateRow`                           | 2.8%        | **4.4%**    | +1.6 pp    |
| `samples.js:add`                                    | —           | 0.9%        | NEW        |
| `samples.js:snapshot`                               | —           | 0.8%        | NEW        |

### Inclusive-time — the double-dispatch story

| Frame                                       | V6 incl   | V7 incl   | Δ              |
| ------------------------------------------- | --------- | --------- | -------------- |
| `LivePartitionedSeries.#routeEvent`         | 15.0%     | **28.9%** | **+13.9 pp**   |
| `LivePartitionedSyncRolling.ingest` (incl)  | 11.5%     | **25.0%** | **+13.5 pp**   |
| `LiveSeries._pushTrustedEvents`             | 13.1%     | **27.4%** | **+14.3 pp**   |
| `pushMany`                                  | 42.8%     | 51.8%     | +9.0 pp        |

Every per-event pond-internal hop roughly doubled in inclusive time.
This is the V7 cost story in one line.

## Read

V7's regression is **the second rolling**, not the `samples` reducer.
The reducer itself adds ~2.3% self-time (`samples.js` + `samples.add` +
`samples.snapshot`) — small enough to be noise. The heavy hitter is
that **every event now flows through two `LivePartitionedSyncRolling`
instances** instead of one + a passive `live.on('batch', cb)`
listener:

- `#routeEvent` per-event work is now done twice (once per rolling).
- `ingest` per-event work is done twice.
- `_pushTrustedEvents` traversal-and-dispatch is doubled.
- `#evictPartition` (per-tick-boundary partition cleanup) shows up
  prominently in V7 — it's a per-rolling per-tick pass and there are
  now two of them; visible at top-25 self-time only because two
  copies overlap less with GC.
- `#validateRow` and `Event` allocation also rise, knock-on from the
  doubled ingest path even with trusted-pipeline routing.

V6's manual deque sat off `live.on('batch', cb)` — pond's broadcast
fires once per batch, and the deque's per-event work (`push` + tick-
time `splice`) is cheaper than going through the full per-event pond
ingest pipeline a second time.

User-code self-time drops as expected (`aggregate.ts` 2.3% → 0.3%) —
the manual deque + `sliceSamplesAtTick` walks were ~400ms over the
20s window. The V7 user code is essentially free. But pond pays back
~12pp in `LivePartitionedSyncRolling` self-time and ~14pp in
inclusive time on every per-event hop — net regression at ceiling.

## Suggestions for the library agent

These are profile-driven asks; the experiment ships V7 as the supported
shape regardless.

1. **Multi-output rollings on the same window — share the per-event
   ingest pass.** The current API forces two separate `rolling()`
   calls when the windows differ (1m baseline vs 200ms slice). Each
   maintains its own per-partition bookkeeping and ingests events
   separately. A "fused multi-window rolling" — one ingest pass that
   updates several windows — would close the doubled `ingest` /
   `#routeEvent` cost. API sketch:

   ```ts
   byHost.rolling([
     { window: '1m',    output: { cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count' } },
     { window: '200ms', output: { cpu_samples: 'samples' } },
   ], { trigger });
   ```

2. **`#evictPartition` is hot enough to be worth a look.** 8.8% self-
   time at ceiling is not what I expected from a per-tick cleanup
   path. May be doing per-partition allocations or array-shifts that
   could be amortised.

3. **`samples.js` itself is fine.** 2.3% self-time across `add` +
   `snapshot` is reasonable for a built-in array reducer. No
   optimisation pressure here unless (1) lands and the cost
   redistributes.

4. **Heap deltas are the second rolling's per-bucket array state**,
   not the user-code deque going away. V6's deque was bounded to the
   200ms window; V7's `samples` reducer holds the full bucket array
   in pond's reducer state. At 87k/s × 200ms × ~100 hosts × ~870
   samples/host/window that's ~17MB extra of live arrays — close to
   the +269MB heap delta after JS engine bookkeeping (object headers,
   gen-1 promotions). If (1) ships, the heap delta would also close
   because the slice rolling wouldn't be a separate consumer.

## What this isn't

- Not a regression in `samples()` itself — the reducer is fine.
- Not a regression in pond 0.14.2 generally — the V6→V7 delta is
  driven entirely by going from one rolling to two.
- Not user-fixable in the experiment — there's no API today to fuse
  the two rollings into one ingest pass. The shape we want needs (1)
  above.

The 19% throughput gap and 17% moderate-load heap bump are the price
of the cleaner V7 shape until the library lands a fused-rolling
primitive.
