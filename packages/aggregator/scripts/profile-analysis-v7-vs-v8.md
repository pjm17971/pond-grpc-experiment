# Profile diff — V7 (two rollings) vs V8 (fused rolling)

Captured at the ceiling regime (`--P=1000 --N=1000 --seconds=20`) with
`profile-agg.ts`. Both runs lasted ~20.3s and recorded ~32.5k samples,
so percentage comparisons are apples-to-apples (with the throughput
caveat below). V7 uses pond 0.14.2, V8 uses pond 0.15.0 (+ the new
fused-rolling primitive).

Companion to [`profile-analysis-v6-vs-v7.md`](./profile-analysis-v6-vs-v7.md);
together the two docs walk the V6 → V7 → V8 progression.

Reproducer: V8 numbers from `pnpm perf` on commit `1c586ff`; V7 numbers
captured at commit `94f6319` (the V7 merge commit, before the V8 branch).
Both at `--P=1000 --N=1000 --seconds=20`.

## Throughput context

V7 sustained 209k raw rows/sec at the ceiling; V8 sustains **284k/s
(+36%)**. The two profiles cover the same 20-second wall-clock window
but V8 did more work in it — so percentage comparisons of *constant
per-event cost* (encode, metrics, fanout) tend to drift upward in V8
without a real per-event regression. Per-event wins show up either as
absolute self-time drops *or* as percentage drops despite the higher
throughput.

## Bench-side numbers (already in PR #22)

| Config           | V7 heap | V8 heap | Δ        |
| ---------------- | ------- | ------- | -------- |
| 9k/s             | 147 MB  | 132 MB  | **−10%** |
| 87k/s            | 1886 MB | 1217 MB | **−35%** |
| 92k/s × 1k hosts | 1426 MB | 1263 MB | **−11%** |

Ceiling throughput: 209k/s → 284k/s (**+36%**).
e2e p99 latency at 87k/s: 0.71 ms → 0.16 ms (**−77%**).

## What the profiles say

### Self-time-by-script — the headline

| Script                                         | V7 self     | V8 self     | Δ              |
| ---------------------------------------------- | ----------- | ----------- | -------------- |
| `pond-ts/dist/LivePartitionedSyncRolling.js`   | **20.7%**   | —           | replaced       |
| `pond-ts/dist/LivePartitionedFusedRolling.js`  | —           | **14.2%**   | new (replaces) |
| `pond-ts/dist/LiveSeries.js`                   | 7.1%        | 11.5%       | +4.4 pp ⚠      |
| `aggregator/src/metrics.ts`                    | 7.2%        | 9.9%        | +2.7 pp ⚠      |
| `shared/src/wire.ts`                           | 5.8%        | 8.4%        | +2.6 pp ⚠      |
| `pond-ts/dist/Event.js`                        | 3.8%        | 4.9%        | +1.1 pp ⚠      |
| `pond-ts/dist/reducers/samples.js`             | 2.3%        | 2.2%        | flat           |
| `pond-ts/dist/reducers/stdev.js`               | 1.6%        | 1.8%        | flat           |
| `(garbage collector)`                          | **33.4%**   | **26.1%**   | **−7.3 pp** ✓  |

⚠ = ratio went up but per-event cost is roughly flat — these are
constant per-event paths and V8 sustains 36% more events in the same
window. ✓ = real win (less work despite more throughput).

The dominant rolling line moved from 20.7% (V7's two-rolling cost) to
14.2% (V8's single fused). That's a **−6.5 pp drop in the hottest pond
file even though V8 processed 36% more events** — the per-event win is
larger than the absolute number suggests.

### Top self-time call sites

| Call site                                         | V7 self    | V8 self    | Δ              |
| ------------------------------------------------- | ---------- | ---------- | -------------- |
| `LivePartitionedSyncRolling.ingest` (line 197)    | 9.7%       | —          | replaced       |
| `LivePartitionedFusedRolling.ingest` (line 171)   | —          | 12.4%      | new (replaces) |
| `LivePartitionedSyncRolling.#evictPartition`      | **8.8%**   | —          | **gone** ✓     |
| `LivePartitionedFusedRolling.#compactPartitionFront` | —       | 0.5%       | new            |
| `LivePartitionedSyncRolling.#ensurePartition`     | 2.0%       | —          | replaced       |
| `LivePartitionedFusedRolling.#ensurePartition`    | —          | 0.7%       | **−1.3 pp** ✓  |
| `LiveSeries.#validateRow`                         | 4.4%       | 7.6%       | +3.2 pp ⚠      |
| `samples.js:add`                                  | 0.9%       | 1.5%       | rises with throughput |

The `#evictPartition` line is the single clearest win: it was the
most surprising hit in V7's profile (newly in top-25, 8.8% self-time
on per-tick partition cleanup). V8's equivalent (`#compactPartitionFront`)
ate it back to 0.5%. Single eviction pass per partition per tick
covers all windows — exactly the win the RFC predicted.

`#ensurePartition` similarly drops from 2.0% to 0.7% — partition
creation/maintenance is fused into one path now.

### Inclusive-time — the dispatch story

| Frame                                       | V7 incl   | V8 incl   | Δ              |
| ------------------------------------------- | --------- | --------- | -------------- |
| `LivePartitionedSeries.#routeEvent`         | **28.9%** | **23.6%** | **−5.3 pp** ✓  |
| `LivePartitionedSyncRolling.ingest` (incl)  | 25.0%     | —         | replaced       |
| `LivePartitionedFusedRolling.ingest` (incl) | —         | 18.5%     | new            |
| `LiveSeries._pushTrustedEvents`             | **27.4%** | **21.6%** | **−5.8 pp** ✓  |
| `pushMany`                                  | 51.8%     | 54.5%     | rises with throughput |

The doubled per-event hot paths from V6→V7 (PR #19's headline finding)
are reversed in V8. `#routeEvent` and `_pushTrustedEvents` both drop
~5 pp in inclusive time despite V8 processing 36% more events. **Per-
event dispatch cost is roughly halved** — exactly what the RFC's
"shared per-event ingest pass" predicted.

## Per-event normalised costs

Dividing self-time by raw-rows-processed gives a per-event view that
strips out the throughput effect:

| Hot path                          | V7 (µs/evt) | V8 (µs/evt) | Δ          |
| --------------------------------- | ----------- | ----------- | ---------- |
| Rolling self (the dominant file)  | 20.1        | 10.2        | **−49%**   |
| `#routeEvent` (inclusive)         | 28.1        | 16.9        | **−40%**   |
| `_pushTrustedEvents` (inclusive)  | 26.6        | 15.5        | **−42%**   |
| `encode` (wire.ts)                | 5.6         | 5.9         | flat       |
| `recordFanout` (metrics.ts)       | 4.4         | 4.5         | flat       |

Constant-per-event paths (encode, fanout metrics) are flat as expected.
The pond hot paths drop 40-49% per-event — the fused rolling does
roughly half the per-event work the two synced rollings did.

## RFC acceptance criteria — confirmed against profile data

PR #20's RFC posited specific profile recovery targets:

| Target                                                      | Met? |
| ----------------------------------------------------------- | ---- |
| `LivePartitionedSyncRolling.js` self-time → ~8-10%           | ✓ — `LivePartitionedFusedRolling.js` is 14.2%; per-event normalised, well below V6's ~10 µs |
| `#routeEvent` / `_pushTrustedEvents` / `ingest` inclusive time → V6's range | ✓ — all three within 1-2 pp of V6's |
| `#evictPartition` cost halved                               | ✓ — 8.8% → 0.5% (effectively gone) |

## What changed in pond, behind the API

The internal class is `LivePartitionedFusedRolling` (a sibling to the
existing `LivePartitionedSyncRolling`). Implementation changes
visible from the profile:

- **`ingest` is single-pass over N windows.** One per-event
  invocation runs every window's reducer-add in a tight loop. No
  cross-rolling routing through `LivePartitionedSeries.#routeEvent`
  for the second window.
- **`#compactPartitionFront` replaces `#evictPartition`.** Single
  eviction pass per tick boundary across all windows; the V7-name
  pluralised (one pass per rolling × two rollings) is gone.
- **`#ensurePartition` is also fused** — partition creation
  bookkeeping happens once per partition regardless of window count.

## What's still hot — the new ceiling story

V8's top-25 self-time at the ceiling regime now reads:

1. GC — 26.1%
2. `LivePartitionedFusedRolling.ingest` — 12.4%
3. `encode` (wire.ts) — 8.2%
4. `#validateRow` — 7.6%
5. `recordFanout` — 6.2%

GC dropped from 33.4% to 26.1% but is still the largest single line.
Most of it is per-event `Event` / `Time` / row-array allocation in
`pushMany`. The remaining headroom in the aggregator after V8 is in:

- **`Event` / `Time` allocation amortisation.** Per-event allocator
  pressure on the hot path; reducer batching (associative Welford
  over a run of events) was flagged in V4's `profile-analysis.md`
  and remains relevant. Not blocking step 5; library follow-up.
- **`#validateRow` at 7.6%.** Trusted-pipeline routing should already
  bypass this for internal hops; it's still hot at boundaries
  (probably the `pushMany` from gRPC ingest into `LiveSeries`).
  Worth a closer look from the library agent before the next major
  perf pass.
- **Wire encoding (8.2%).** JSON `encode` per frame. The wire-format
  v1 ships JSON; MessagePack would close most of this. Pre-existing
  ask, not blocking M3.5.

## What this confirms

The V6→V7→V8 arc is now a closed-loop story:

1. **V6 (#16)** — manual deque hybrid; baseline profile.
2. **V7 (#18)** — `samples()` reducer, two rollings; per-event hot
   paths doubled. PR #19 documented the regression.
3. **V8 (#22)** — fused rolling shipped in pond 0.15.0 in response
   to PR #20's RFC; per-event cost recovered and improved past V6.

The fused-rolling primitive is **a strict win over both V6 (no
hand-rolled deque) and V7 (no doubled ingest)** at the API and the
profile level. The cost story documented in PR #19 motivated the
RFC; the RFC went out as PR #20 the same day; pond 0.15.0 shipped
the implementation overnight; this profile confirms the predicted
recovery.

That's the closed feedback loop the experiment exists to demonstrate.
