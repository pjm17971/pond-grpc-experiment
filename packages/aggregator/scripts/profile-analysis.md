# V1 vs V3 throughput-gap analysis (pond 0.13 single-pipeline rolling)

CPU profile comparison of the aggregator at the M3 ceiling regime
(P=1000 × N=1000, ~410k vs ~200k events/sec achieved). Profiles
captured by `scripts/profile-agg.ts` at the same load against both
implementations, 20-second runs.

The bench numbers (`bench:agg`) showed V3 achieves ~50% of V1's
ceiling throughput. The profile says where the extra cost lives.

## Top self-time, side-by-side

(Where a function shows up in both columns it's pre-existing
experiment code; the new entries in V3 are pond rolling internals.)

| Function (file)                                     | V1     | V3     | Δ      |
| --------------------------------------------------- | ------ | ------ | ------ |
| (garbage collector)                                 | 28.7%  | 34.3%  | +5.6%  |
| `encode` (wire.ts) — JSON serialisation             | 12.2%  | 6.6%   | -5.6%* |
| `estimateEventBytes` (LiveSeries.js)                | 2.0%   | **6.2%** (5.3 + 0.9) | +4.2% |
| `recordFanout` (metrics.ts)                         | 7.1%   | 4.9%   | -2.2%* |
| `LivePartitionedSyncRolling.ingest` ← **new in V3** | 0%     | 4.1%   | +4.1%  |
| `recordIngest` (metrics.ts)                         | 5.4%   | 2.7%   | -2.7%* |
| `toJsonRow` (Event.js)                              | 5.2%   | 3.1%   | -2.1%* |
| `HostAggregator.record + .tick` (aggregate.ts)      | 7.5%   | 0%     | -7.5%  |
| `#validateRow` (LiveSeries.js)                      | 2.4%   | **4.5%** (2.5 + 2.0) | +2.1% |
| `pushMany` (LiveSeries.js)                          | 2.3%   | **3.4%** (2.3 + 1.1) | +1.1% |
| Partition routing — `LivePartitionedSeries.#routeEvent` + anonymous + `#ensurePartition` ← **new in V3** | 0% | 4.4% | +4.4% |
| `Event` constructor (Event.js)                      | 1.9%   | **2.4%** (1.2 + 1.2) | +0.5% |
| `stdev.add` (reducers/stdev.js) ← **new in V3**     | 0%     | 2.4%   | +2.4%  |
| `avg.add` (reducers/avg.js) ← **new in V3**         | 0%     | 0.7%   | +0.7%  |

\* V3 ingests fewer raw events at this load (200k/s vs 410k/s); the
percentages decrease for code paths whose absolute cost scales
with raw rate (encode/recordFanout/recordIngest/toJsonRow). The
relative shape is what matters here, not the percentage drops on
those rows.

## What's costing what

**V1's extra time is in tight numeric loops** — the `HostAggregator`
`record()` and `tick()` show up at ~7.5% combined, doing nothing
but pushing a `number` to a `number[]`, incrementing a counter,
and (every 200ms) sweeping the buffer for mean+sd. No allocation
per event, no schema work, no partition routing.

**V3's extra time is in pond's internal layering**:

1. **Partition routing on every event** (~4.4% combined). Every
   source event has to be classified into its partition's sub-
   series — `#routeEvent` + the partition-spawn anonymous in
   `LivePartitionedSeries.js:442` + `#ensurePartition` for new
   hosts.

2. **Per-event rolling-stats update** (~4.1%). `LivePartitionedSyncRolling.ingest`
   updates the rolling window's running totals incrementally on
   each event. This is the "pond owns the math" win at the cost
   of doing it per event rather than once per tick like
   `HostAggregator.tick()` does.

3. **Internal pushMany layering** (~7-8% combined: 4.5% validate
   + 3.4% pushMany + 6.2% estimateEventBytes). Each source event
   goes through `pushMany` **twice or three times** internally —
   once into the source `live` series, then `routeEvent` calls
   `pushMany` on the partition sub-series, and the rolling
   pipeline ingests from that. Each layer:
   - validates the row (`#validateRow`),
   - computes byte estimates (`estimateEventBytes`),
   - constructs an `Event` instance.

4. **More GC pressure** (+5.6%). Direct consequence of the extra
   allocations: more `Event` objects, more `Time` keys, more
   intermediate arrays.

5. **Incremental reducer cost** (~3% combined for stdev + avg).
   Pond's reducers are incremental and numerically careful (Welford
   for stdev) — that's *correct*, but it's per-event work where
   `HostAggregator` did one mean-and-variance pass per 200ms tick.

## Concrete asks for the library agent

Ranked by likely throughput recovery:

1. **`estimateEventBytes` (6.2% self time, the largest single
   over-V1 line item).** What does this compute? If it's bytes-
   for-retention, can it be amortised (once per push batch, not
   per row)? Or skipped when retention is age-based, not
   bytes-based? At 200k/s this is ~12k calls/sec per host across
   1k hosts — 12M+ calls/sec total, and they're all near-identical.

2. **`#validateRow` runs on every internal pushMany layer (4.5%
   combined).** Events flowing from `live` into a partition
   sub-series and then into a rolling buffer have already been
   validated at the source. An "internal trust" path that skips
   re-validation on derived-pipeline pushMany would close most
   of this.

3. **Per-event Event allocation in the partition + rolling
   layers.** If the rolling pipeline can hold its working state
   in plain numeric fields and only construct an `Event` instance
   at *emit* time (one per partition per boundary, not one per
   source event), the GC pressure drops materially.

4. **Reducer batching.** The 3% spent in stdev.add + avg.add per
   event could become ~0% if the reducers worked over a run of
   events at once (Welford's is associative and trivially batches).
   Unclear how much practical wiring that needs.

## Caveat

These percentages are at the M3 ceiling regime where the event loop
is saturated. At the dashboard's expected production rate (≤100k/s)
the same per-event overheads exist but have proportionally more
budget; the bench shows V3 there is sub-2ms p99 latency, ≤8% minor
GC, no missed ticks. The optimisation work above buys back the
ceiling regime and reduces moderate-load heap; it isn't blocking
step 1's correctness or the dashboard's typical operation.

## Reproducing

```bash
# V3 (this branch, pond 0.13 with AggregateOutputMap):
pnpm exec tsx packages/aggregator/scripts/profile-agg.ts --P=1000 --N=1000 --seconds=20
# V1 (main, manual HostAggregator):
git checkout main && pnpm install
pnpm exec tsx packages/aggregator/scripts/profile-agg.ts --P=1000 --N=1000 --seconds=20

# Profiles land in /tmp/agg-prof. The largest .cpuprofile per run
# is the actual aggregator process (not the tsx wrapper). Open
# in Chrome DevTools (chrome://inspect → Open dedicated DevTools
# for Node → Profiler → Load) or run the analyzer:
#   node /tmp/analyze-cpuprofile.mjs <path>.cpuprofile
```
