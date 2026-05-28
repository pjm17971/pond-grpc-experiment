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

**Status:** Pending (queued 2026-05-28).
**Owner:** gRPC experiment agent (Claude).
**Next action:** Run `pnpm perf`, capture V5 numbers, append V5
section to `M3.5.md`.

### Phase B status

**Status:** Not started. Awaits Phase A signal.
**Step 7 vs Step 3C ordering:** TBD by V5 profile.

### Phase C status

**Status:** Not started. Awaits Phase B PR(s) merged into pond-ts
main and a new pond-ts version published.

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
