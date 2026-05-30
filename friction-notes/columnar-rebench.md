# V5 columnar re-bench — wave plan

**Date queued:** 2026-05-28
**Status:** Phase A pending. Self-contained binding plan; a fresh
session can resume from this file alone.

## Why this wave exists

The columnar substrate in pond-ts (Phase 4.7 of pond-ts's PLAN.md)
was strategically motivated by *this* experiment's friction —
specifically the V3 → V4 profile findings that flagged
`estimateEventBytes` (gone in v0.14.0) and the `Event → row →
Event` round-trips (gone in v0.14.0) as the dominant cost lines.
V4 measured the recovery: heap −17% to −50% across moderate loads,
ceiling throughput +23% (208k → 256k events/s), tick fps +30%, p99
1.91ms → 1.15ms.

Since V4 (measured at pond-ts v0.14.0), pond-ts has shipped a lot:

- **v0.15.0** — fused multi-window rolling. Already adopted in
  `aggregate.ts` (V8 stage in [`M3.5.md`](./M3.5.md)).
- **v0.16.0** — `pipeline.stats()` accessor across 8 live classes.
- **v0.17.0** — `live.sample()` bounded-memory stream sampling.
- **v0.17.1** — `partitionBy` default-inherit (closes the M4 footgun).
- **Phase 4.7 substrate, internal:** Step 1 framework layer (1a–1h),
  Step 2 TimeSeries integration (2a–2c — 3.6× faster TimeSeries
  construction at N=100k, 3× point access), Step 3 Phase A
  reducer fast path (`series.reduce()` 35–73× on packed numeric
  columns).
- **Phase 4.7 substrate, public:** column-centric API (steps 8a–8d)
  validated by the chart-experiment at N=10M / 60fps (see
  [`pond-ts-charts-experiment/STATUS.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/STATUS.md)).

None of the above has been re-benched against the gRPC workload.
The honest gap: **the gRPC hot path (`pushMany` → `partitionBy →
rolling` → fanout) doesn't yet exercise the substrate.** Steps 7
(`LiveSeries` columnar ring buffer) and 3 Phase C (rolling fast
path) are the deferred levers, and the V4 profile already named
both of them as the structural fixes for the 38% V1→V4 ceiling
gap. The wave closes that loop.

## Wave shape — Phase A → B → C

### Phase A — Baseline V5 re-bench (gRPC agent, no library code)

**Goal.** Run the V4 bench harness against the current v0.17.1 pin
to produce a V5 row of the V1→V2→V3→V4 bench table. No library
work; no PRs against pond-ts. Output is a friction note + a profile
delta.

**Procedure.**

1. Confirm clean tree, current main, pond-ts pin matches what's on
   pond-ts main (`^0.17.1`). If pond-ts main has advanced, decide
   whether to bump or hold (note in V5 report).
2. Run `pnpm perf` (canonical perf suite per
   [`scripts/perf.sh`](../scripts/perf.sh)):
   - bench:agg at four load points: P=100 N=100, P=100 N=1000,
     P=1000 N=100, P=1000 N=1000
   - profile-agg at the ceiling (P=1000 N=1000, 20s)
3. Capture results in a new section appended to
   [`M3.5.md`](./M3.5.md) — extends the V1 → V4 table to V5.
4. Analyze the V5 cpuprofile vs the V4 cpuprofile (the standing
   `analyze-cpuprofile.mjs` helper). Identify:
   - Which V4 cost lines moved (and by how much)
   - Which V4 cost lines held (and at what self-time %)
   - Any new cost lines that didn't exist at V4
5. Write the V5 report. Format mirrors V4's: bench table, profile
   delta, "what this tells us about Phase B prioritization."

**What V5 measures (and what it doesn't).**

V5 measures **the substrate's free wins**. v0.15–v0.17 wins are
captured (fused rolling, partitionBy default-inherit). Internal
Phase 4.7 wins — lazy events, column-native intake on snapshot
boundaries, the `reduce()` fast path — register *only* if the gRPC
hot path actually touches those code paths today. They mostly
don't:

- `pushMany(rows)` goes through `validateAndNormalize`, not
  `validateAndNormalizeColumnar`. Column-native intake is wired to
  snapshot/batch construction (`TimeSeries.fromValidatedRows`), not
  to `LiveSeries.pushMany`.
- `LivePartitionedSyncRolling.ingest` still walks per-event
  Welford. The `reduce()` fast path doesn't apply to live rolling.

So a flat-or-slight-improvement V5 is the expected (and honest)
outcome. The value of V5 isn't the numbers — it's the **profile**:
where V4's costs landed vs where V5's do. Phase B prioritizes Step
7 vs Step 3C based on which line is currently the biggest.

**Public API consequences for Phase A.** None.

**Deliverable.** A V5 section in `M3.5.md` (or a sibling `M5.md`
if scope outgrows M3.5) + a one-line update to
[`PLAN.md`](../PLAN.md)'s Active wave note.

**Exit criteria for Phase A.**

- V5 bench table appended to M3.5.md (matches V4 format).
- V5 profile-delta captured (top 5 self-time lines, before/after).
- A one-paragraph recommendation on Phase B sequencing: "Step 7
  first" or "Step 3 Phase C first" with the cost-line evidence.

### Phase B — Library work on pond-ts (one PR per step)

**Goal.** Land the substrate work the V5 profile points at. One PR
per step, full review discipline, **human approval required before
merge.**

Candidates, in priority TBD by V5:

#### Step 7 — `LiveSeries` numeric ring buffer

**Motivation.** V4 named `Event/Time` allocation on push + per-
event reducer-state updates as the 35.6% GC-pressure source (vs
28.7% manual V1). The `ColumnarRingBuffer` primitive already ships
in pond-ts (step 1h, PR #149). Step 7 is the integration on top —
swap `LiveSeries`'s internal storage from row-shape
`ReadonlyArray<Event>` to columnar ring buffer.

**Public API consequences (load-bearing).** The columnar-core RFC
commits to "Public APIs (`Event`, `at(i)`, `live.on('event')`,
etc.) stay row-oriented at the boundary." Step 7 must preserve
**every** existing `LiveSeries` invariant:

- `live.at(i)` returns an `Event<S>` reference (lazy materialization
  is acceptable — same pattern as TimeSeries 2a).
- `live.on('event', cb)` fires per push with an `Event<S>` payload.
- Retention semantics (`maxEvents`, `maxAge`) preserved.
- Ordering modes (`strict` / `drop` / `reorder`) preserved.
- `graceWindow` behavior preserved.
- Subscriber ordering (`event` → retention → `batch` → `evict`)
  preserved.
- `toTimeSeries()` snapshot semantics preserved (and ideally
  *faster* — the ring's columnar storage maps directly to the new
  columnar TimeSeries).
- `pushMany(rows)` / `pushJson(rows)` / `pushBatch` paths preserved.
- `LivePartitionedSeries` per-partition sub-series still work
  identically (they're `LiveSeries` instances internally).

**The PR's design section must enumerate every invariant and
specify a pin-test for it.** "Invariants preserved" subsection in
the body, with one test name per invariant.

**Benchmark protocol.** The V4 bench harness, before and after.
Targets:
- 35.6% GC-pressure line drops materially.
- Ceiling rate moves (target: closes some of the 38% V1 gap).
- p99 stays ≤ 2ms at moderate loads.
- Heap envelope at 9k/s / 87k/s / 92k×1k stays within V4 levels
  or improves.

**Estimated PR size.** ~600-1000 LOC. Touches `LiveSeries`,
internal column-native push paths, snapshot construction. Tests
broad — every live-side invariant pin.

**Review.** Layer 2 adversarial agent. Codex pass mandatory
(deep type-system + correctness work; below-high confidence is
the default until the invariant pin tests are in place).

#### Step 3 Phase C — `series.rolling()` columnar fast path

**Motivation.** V4 named `LivePartitionedSyncRolling.ingest` at
8.2% self-time at ceiling — the per-event Welford update.
Substrate-aware reducer logic for sliding windows (monotonic
deque for min/max; running-stats for mean/stdev) on Float64Column
would collapse this.

**Public API consequences (TBD).** The internal-vs-public split
question:

- Internal: `rollingColumn` is a hidden hook on the reducer
  registry; built-in reducers get the fast path automatically;
  custom reducers continue to use the per-event loop. Zero public
  API surface. Mirror of PR #153 Phase A's `reduceColumn`.
- Public: `rollingColumn` becomes a published extension contract
  (analogous to `CustomAggregateReducer`'s public shape) so
  experiment/user code can write substrate-aware custom reducers.

**Default: internal-only**, unless V5 surfaces a user need for
custom substrate-aware rolling reducers. Defer the public
extension question to that signal.

**Benchmark protocol.** The V4 bench harness, focused on the
ceiling regime (P=1000 N=1000). Targets:
- `LivePartitionedSyncRolling.ingest` self-time drops from 8.2%
  to ≤ 3%.
- Ceiling rate moves (substrate now does the reducer state work
  it was meant to).
- Validity of stdev / mean unchanged (Welford → substrate-running-
  stats parity).

**Estimated PR size.** ~400-700 LOC. Touches `live-rolling-*.ts`,
the reducer registry, per-reducer state primitives. Tests pin
numerical parity with the existing per-event path on the same
inputs.

**Review.** Layer 2 adversarial agent. Codex pass mandatory
(numerical stability + sliding-window correctness).

### Phase C — Consumer re-adoption + dashboard validation

**Goal.** Validate that what Phase B shipped actually closes the
strategic loop, with **two independent consumer reports**.

**gRPC re-adoption (this experiment):**
1. Bump pond-ts pin to whatever ships from Phase B.
2. Run the V4 bench harness again — produce V6 row.
3. Profile delta: did the targeted V4 cost lines collapse?
4. Update M3.5.md with V6.
5. If the writeup is being assembled, this is the closing data
   point.

**Dashboard agent inclusion.** Per the project CLAUDE.md, the
dashboard agent at
[`pjm17971/pond-ts-dashboard`](https://github.com/pjm17971/pond-ts-dashboard)
is the second consumer surface — they own the React `useSnapshot` /
`useLiveQuery` / `useLatest` / `useDerived` path and will inform
the eventual `@pond-ts/charts` extraction. When Phase B ships:

1. Loop the dashboard agent in for adoption friction on the same
   substrate.
2. They re-bench their snapshot/render path; report wins or gaps.
3. Their friction may surface different substrate steps that earn
   library work next (Step 4 derived transforms, Step 6 string/
   dict reducers, Step 8e/f/g column-API extensions).

Substrate's strategic justification is met when **both** consumers
(gRPC and dashboard) report wins from Phase B.

## Operating rules

1. **PR merges wait for human approval.** Standing instruction
   from 2026-05-28. Layer 1 self-review + Layer 2 adversarial
   agent review + Codex pass when below-high confidence per
   pond-ts's CLAUDE.md merge protocol, then **stop**. Include link
   + summary; wait for human go-ahead.
2. **Benchmark ruthlessly.** Every Phase B PR carries a
   before/after table in the commit message. V4 format is the
   template. If a claim isn't measured, it doesn't ship.
3. **Plan summary + motivation + API-impact in every PR body.**
   Even invariant-preserving changes get an explicit "invariants
   preserved" subsection with one test name per invariant. The
   user reads PR bodies cold between engagement windows; the body
   must be self-sufficient.
4. **Agent identity in PR comments.** Per pond-ts CLAUDE.md:
   `> _Posted by the gRPC experiment agent (Claude)_` for
   experiment-side commentary; `> _Posted by the pond-ts library
   agent (Claude)_` for library-side. Role tags
   (`_— friction report_`, `_— review response_`) optional.
5. **Friction notes in the experiment, not pond-ts.** V5/V6
   findings + cost-line deltas land here (this file or `M3.5.md`).
   Library-actionable items get the corresponding pond-ts PR with
   a back-reference to this file.
6. **No measurement, no shipping.** Phase A is the gate for Phase
   B; Phase C closes the loop. If V5 shows the substrate's free
   wins are already enough to hit production targets, that's the
   honest report — Step 7 and Step 3C earn their work only when
   measured friction calls for them.

## State tracking

Status updated as the wave progresses. Sections only filled in as
each phase completes — until then, the absence is the signal that
work is pending.

### Phase A status

**Status:** ✅ Complete (2026-05-29). V5 bench + profile + regression
bisect captured in [`M3.5.md`](./M3.5.md). Recommendation was "Step 7
first" (GC the dominant cost line at 22%).

### Phase B status

**Status:** Step 7 attempted and **WALKED BACK** (2026-05-29) after
measurement falsified the thesis. Step 3 Phase C not started.

**Step 7 (LiveSeries columnar ring buffer) — NO-GO.** The
storage-strategy refactor that preceded it earned its keep (shipped
as pond-ts PR #168) and stays; the ring backing itself did not.

Bench (pond-ts side, `scripts/perf-live-series.mjs`):

| metric | ring | Event[] | result |
| --- | --- | --- | --- |
| ingest (pushMany 300k, 50k window) | 630 ms | 67 ms | ring **9.4× slower** |
| heap retained (200k window, isolated) | 36.2 MB | 27.9 MB | ring uses **more** |

**Why the ring can't win here — the durable finding.** The gRPC
hot path *needs* `Event` objects: the rolling pipeline subscribes
to `'event'`, so `LiveSeries` materializes an Event per row
**regardless of backing**. The ring then *decomposes* that Event
back into typed-array columns — strictly more work than the array
backing (create + decompose vs create + store-reference) — and its
only theoretical payoff (not retaining the events) didn't even show
as a heap win. **A columnar *buffer* doesn't avoid the allocation
when the consumer needs events.** Only a columnar *rolling reducer*
that consumes columns instead of `Event`s (pond-ts Step 3 Phase C)
would actually cut the V5 GC pressure. That reframes the V5
recommendation: "Step 7 first" was wrong; the GC line is driven by
the rolling pipeline's event consumption, not by buffer storage.

**What landed / what was reverted on pond-ts:**

- Kept: PR #168 — `LiveStorage<S>` strategy layer +
  `EventArrayLiveStorage` (behavior-preserving extraction).
- Reverted: PR #169 reverts #167's `_appendRowTrusted` substrate
  method (the ring prerequisite, now dead).
- Abandoned (recoverable record, not merged): branch
  `feat/step-7-ring-storage` holds the full `RingLiveStorage`
  attempt + bench.

**Step 3 Phase C (columnar rolling reducer)** is the *real* lever
for the V5 GC pressure, but it's a much larger change (per-reducer
columnar state machines) and earns its slot only if a future
workload pushes near ceiling. Production target is 100k/s; V5 hits
~210k/s. Deferred until friction earns it.

### Phase C status

**Status:** N/A — no Phase B library work shipped to re-adopt. The
wave's measurable conclusion: the substrate had already delivered
its free wins (lazy events, fused rolling) by v0.17.1; the next
real lever (columnar rolling) doesn't earn its cost at current
production headroom.

## Cross-references

- [`pond-ts PLAN.md` Phase 4.7 "Next wave"](https://github.com/pjm17971/pond-ts/blob/main/PLAN.md#next-wave-grpc-re-bench--substrate-adoption-queued-2026-05-28)
  — the binding pond-ts side of this plan.
- [`M3.5.md`](./M3.5.md) — V1 → V4 bench table + profile data. V5
  appends here.
- [`M4.md`](./M4.md) — late-data friction; partitionBy fix at v0.17.1.
- [`pond-ts-charts-experiment STATUS.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/STATUS.md)
  — chart-experiment's adoption pattern; reference for this wave's
  discipline.
- [`pond-ts CLAUDE.md`](https://github.com/pjm17971/pond-ts/blob/main/CLAUDE.md)
  — multi-agent experiment discipline + PR review protocol.

---

## Appendix — V6 re-bench on pond-ts v0.18.0 + §A before-number (2026-05-30)

**Trigger.** pond-ts v0.18.0 shipped npm-side. PR #170 is the chunked
columnar `LiveSeries` backing (the OOM fix this experiment's heap
profile yesterday motivated). Library agent asked for a re-adoption
A/B + a §A before-number for the column-native-output spike.

**Workload.** Same OOM cell as yesterday's heap profile: 100 hosts ×
700 eps/host = 70k/s target, retention `90s`, ordering `'strict'`,
time-keyed. Heap snapshot at +75s into the aggregator process,
`/metrics` scrape at +85s (no `/live` or `/live-agg` WS clients —
fanout work happens but is broadcast to zero recipients, isolating
the allocation pressure cleanly).

### Headline — chunked backing engaged, retained-Event count unchanged

The library agent's prediction was a 5–9× retained Event/Time heap
drop. The measurement showed something different:

| metric | 0.17.1 (yesterday) | 0.18.0 (today) | delta |
| --- | --- | --- | --- |
| heap snapshot file | 4.44 GB | 4.76 GB | +7% |
| total node self-size | 1.92 GB | 2.22 GB | **+16%** |
| nodes (total) | 55.33M | 63.27M | +14% |
| `Event` count | 6,766,680 | 6,766,580 | **unchanged** |
| `Time` count | 6,729,550 | 6,729,450 | **unchanged** |
| `Event + Time` self-size | 514.8 MB | 514.8 MB | unchanged |
| `Object` (data records) | 683 MB | 683 MB | unchanged |

The chunked backing **did** engage on the source `LiveSeries` (its
storage signatures appear in the heap):

| new in 0.18.0 | count | bytes |
| --- | --- | --- |
| `JSArrayBufferData` (chunk-backing bytes) | 201,920 | 154.5 MB |
| `ArrayBuffer` | 201,932 | 16.9 MB |
| `Float64Array` (numeric columns) | 201,881 | 18.5 MB |
| `Float64Column` (wrapper) | 134,574 | 8.2 MB |
| `StringColumn` (host dictionary) | 67,287 | 5.1 MB |
| `TimeKeyColumn` | 67,287 | 3.6 MB |
| `ColumnarStore` (one per chunk) | 67,287 | 3.6 MB |
| **total chunked-storage overhead** | | **~210 MB** |

The chunk count (67,287) matches `pushMany.calls = 67,318` to within
a few startup batches — one chunk per `pushMany`, as documented.

### Why the Events didn't drop — partition sub-series carve-out

Per the 0.18.0 CHANGELOG, the chunked backing applies to
"top-level LiveSeries with `ordering: 'strict'` and a time key";
the carve-out names "**internally-created series**" as still on the
per-row `Event[]` path.

`partitionBy('host')` creates 100 internally-managed per-partition
sub-`LiveSeries` instances, one per host. Each retains its share of
Events the standard way. At 6.73M events / 100 hosts = ~67k events
per partition × 100 partitions = 6.73M Events. Snapshot confirms:
the `Event`/`Time` retention is downstream of the source, in the
partition sub-series.

The 106 `LiveSeries` instances visible in the snapshot resolve as:
1 source + 100 partition sub-series + 5 other internal (rolling).
The chunked-storage signatures (67k chunks) match the source's
`pushMany` count exactly, confirming **only the source engaged the
chunked backing**.

**Net retained heap on 0.18.0 went UP** by ~210 MB (chunked overhead
layered onto unchanged partition retention) — not down 5–9×. The
library agent's predicted win does not materialise for the
experiment's consumer pattern (partitioned rolling over a high-
partition-count source) because the dominant retention is in the
partitioned sub-series, not the source. This is the disqualifying
condition the library agent's email asked me to flag if Event-count
didn't drop.

**Pond-side fix to surface to the library agent (separate ask, not
in §A's scope):** extend the chunked backing to internally-created
partition sub-series, OR have `partitionBy(...)` route events to its
sub-series via a column-native intake path that doesn't materialise
`Event[]` per partition. Without that, the OOM-motivation high-
partition-count consumer (us) still sees its dominant retention on
0.18.0.

### What the chunked backing DID buy us — latency + GC pause

Even though retention is unchanged, the per-event cost-of-existence
dropped substantially. Likely because the source's storage walk
during GC marking is cheaper when backed by typed arrays instead of
a 6.77M-entry `Event[]`.

| metric | 0.17.1 | 0.18.0 | delta |
| --- | --- | --- | --- |
| minor GC count (over ~165s) | 1,549 | 1,699 | +10% |
| minor GC total pause | 5.54 s | 5.16 s | -7% |
| **minor GC max pause** | **43 ms** | **11.3 ms** | **-74%** |
| major GC count | 8 | 8 | unchanged |
| major GC max pause | 750 ms | 815 ms | +9% (noise) |
| ingest→fanout p99 | 111 ms | **24 ms** | **-78%** |
| pushManyTotal p99 | 15.9 ms | **3.6 ms** | **-77%** |

The 4–5× latency improvements are the real story. The source's
chunked backing makes minor-GC scans much cheaper (typed-array
backings don't need young-gen pointer-graph walks), which collapses
the tail-latency the dashboard cares about. The retained-heap
reduction may be 0 for our consumer, but the GC-pause-driven
latency win is meaningful and would have justified #170 even
without the retained-heap claim.

### §A before-number — listener-boundary allocations

New per-event counters surfaced in `/metrics → columnNativeOutput`
to measure the slice §A removes:

```
columnNativeOutput: {
  fanoutBatchFires:           67,318    // 1 per source pushMany batch
  fanoutEventsTouched:    6,731,800    // every Event in every fanout batch
  fanoutRowsAllocated:    6,731,800    // events.map(e.toJsonRow(schema))
  aggregateBatchEventsTouched: 6,731,800    // every Event in aggregate.ts batch listener
}
```

At firehose × 75s, the source's chunked backing synthesises a
transient `Event[]` per batch-listener fire. Both `fanout.ts` and
`aggregate.ts` subscribe to `'batch'`; pond delivers the same
`Event[]` to both (one synthesis, two listeners). The synthesised
Events are then dropped after the callback returns and GC'd by the
next minor cycle. The row-objects from `events.map(e.toJsonRow(schema))`
in `fanout.ts` are an additional per-Event allocation that also
goes to young-gen and gets GC'd after `JSON.stringify(frame)`.

Per-second rates at this cell (75s × 6.73M events):
- `fanoutBatchFires`: ~898/s
- `fanoutEventsTouched`: ~89,757/s (transient Events synthesised per fanout fire)
- `fanoutRowsAllocated`: ~89,757/s (transient row-objects)
- `aggregateBatchEventsTouched`: ~89,757/s (Events touched by aggregate listener; shared with fanout)

Estimated allocation pressure from this slice alone:
- Events: 89,757/s × ~80 B = ~7.2 MB/s
- Row-objects: 89,757/s × ~50 B = ~4.5 MB/s
- **Total transient: ~11.7 MB/s** at this cell

Over 75s that's ~880 MB of transient allocation churn, which
accounts for most of the observed 1,699 minor GCs (averaging ~22
GCs/s, consistent with ~12 MB/s allocation rate against a typical
young-gen size). The minor GC pressure on 0.18.0 is dominated by
this listener-boundary slice, not by storage-side work.

**Fanout phase latencies** (per-pushMany batch wall-clock):

| phase | 0.17.1 p99 | 0.18.0 p99 |
| --- | --- | --- |
| `fanoutRecordMs` (per-event loop) | 0.26 (from BENCH.md saturation) | 0.043 |
| `fanoutSerializeMs` (`toJsonRow` + `JSON.stringify`) | **0.44** | **2.54** |
| `fanoutBroadcastMs` | 0.05 | 0.00033 |
| `pushManyTotalMs` | 0.88 | 3.60 |

Caveat: the 0.17.1 fanout p99s come from BENCH.md's saturation row
(P=1000, N=1000, ~486k/s achieved), not from yesterday's snapshot
run; the cells aren't directly comparable. The right cross-version
A/B for fanout phase latencies is a follow-up bench at matched
cells. The 0.18.0 numbers here are the canonical §A before-number
for the OOM-cell shape — the column-native output spike's
after-number will run against these.

### Re-adoption validation summary

| claim | result |
| --- | --- |
| Chunked backing auto-engages on top-level strict+time | **✓ confirmed** (67k ColumnarStore + 154MB JSArrayBufferData visible) |
| Retained Event/Time heap drops 5–9× | **✗ unchanged** for high-partition-count source — partitions carve out |
| Latency / GC pause improves | **✓ exceeds expectations** (4–5× tail-latency reduction) |
| Atomic-commit pushMany on chunked path | **✓ transparent** for fanout.ts (no mid-batch length inspection, no throws) |
| Error-message format change (`row N col M (name)`) | one wire-decoder test regex updated (`useRemoteLiveSeries.test.ts`) |
| Interval-keyed BREAKING | N/A — experiment is time-keyed throughout |

### Ping for the library agent

Two follow-ups to surface back:

1. **Partition sub-series carve-out limits the OOM-fix scope.**
   The experiment's heap is dominated by per-partition `Event[]`
   retention, not the source's. #170's "zero retained `Event`"
   claim doesn't realise for partitioned consumers because
   `partitionBy(...)` internally creates per-partition sub-series
   that fall under the per-row carve-out. If the goal is to fix
   the OOM at the experiment's documented cell, this is the next
   lever — either chunked sub-series, or a column-native intake
   that bypasses per-partition `Event[]` allocation. Flagging as
   the disqualifying condition the email asked about.

2. **§A's payoff is bigger than the previous estimate.** With the
   source's storage-side GC pressure substantially reduced by
   #170 (minor-GC max pause 43ms → 11.3ms), the listener-boundary
   transient allocations become the dominant remaining source of
   GC pressure. ~90k transient Events/s + 90k row-objects/s at
   this cell. The column-native output spike's payoff should be
   measurable as: (a) minor-GC count reduction (transient-Event
   path collapsed), (b) `fanoutSerializeMs` p99 reduction (column
   walk vs per-Event `toJsonRow`), (c) `fanoutRecordMs` p99
   reduction (column reads vs `e.get('host')` per Event).

**Artifacts:**
- `/tmp/claude-502/heap-profile-IRYQMY/aggregator.heapsnapshot` (4.76 GB; 0.18.0)
- `/tmp/claude-502/heap-profile-IRYQMY/aggregator.summary.json` (0.18.0)
- `/tmp/claude-502/heap-profile-R53u6p/aggregator.heapsnapshot` (4.43 GB; 0.17.1 baseline)
- `/tmp/claude-502/heap-profile-R53u6p/aggregator.summary.json` (0.17.1 baseline)
- `/tmp/heap-analysis-0180.log` and `/tmp/heap-analysis-strict.log` — analyser outputs

The §A before-number numbers (`columnNativeOutput` counters,
fanout phase p99s) are the canonical AFTER-target for the spike.

