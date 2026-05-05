# RFC: Fused multi-window partitioned rolling

**Status:** draft, awaiting library-agent review
**Author:** the gRPC experiment agent (Claude)
**First raised:** PR #18 (V7 `samples()` migration), PR #19 (V6→V7 profile diff)
**Origin friction note:** [`friction-notes/M3.5.md`](../M3.5.md) — "Anomaly-density requires a 'give me all bucket samples' reducer"
**Proposed pond surface:** `LivePartitionedSeries.rolling` (and parity on `TimeSeries.rolling`)

## Motivation

The experiment's M3.5 step 4 ships per-host anomaly density on `/live-agg` by
joining two windows: a long baseline (1m, for `cpu_avg` / `cpu_sd` / `cpu_n`)
and a short leading edge (200ms, for the raw sample list that anomaly
counting iterates). The aggregator pipeline composes them as two
synchronised partitioned rollings driven off one `Trigger.clock(seq)`.

[PR #19's V6 vs V7 cpuprofile diff](../../packages/aggregator/scripts/profile-analysis-v6-vs-v7.md)
characterises the cost of running them as two separate rollings:

- `LivePartitionedSeries.#routeEvent` inclusive time: 15.0% → 28.9% (+13.9 pp)
- `LivePartitionedSyncRolling.ingest` inclusive time: 11.5% → 25.0% (+13.5 pp)
- `LiveSeries._pushTrustedEvents` inclusive time: 13.1% → 27.4% (+14.3 pp)
- `LivePartitionedSyncRolling.js` self-time: 8.3% → 20.7% (+12.4 pp)
- Ceiling throughput: 258k/s → 209k/s (−19%)

The `samples` reducer itself is ~2.3% self-time across all of `samples.js` —
fine. The regression is **the second rolling**: every event flows through the
per-event ingest pipeline twice.

The natural pond answer is a **fused multi-window rolling** — one
`partitionBy('host').rolling(...)` call that maintains several windows
internally, shares the per-event ingest pass, and emits a single merged event
per partition per boundary.

## Proposal

A new keyed-form overload on `LivePartitionedSeries.rolling`:

```ts
const fused = byHost.rolling(
  {
    '1m':    { cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count' },
    '200ms': { cpu_samples: 'samples' },
  },
  { trigger },
);
// fused: LiveSource<[time, host, cpu_avg, cpu_sd, cpu_n, cpu_samples]>
```

Properties:

1. **One `LiveSource<Out>` output.** The output schema is the merged columns
   from every window's mapping. One event per partition per trigger boundary.
2. **One per-event ingest pass.** Pond visits the partition once per event,
   updates each window's reducer state in a tight loop, and dispatches a
   single fan-out at boundary crossings.
3. **One trigger.** All windows share the trigger's cadence — that's the
   point. Different cadences across windows are the status-quo two-rolling
   case; users who actually want that fall back to two `rolling()` calls.
4. **Time-based windows only** (object keys are duration strings).
   Count-based windows stay on the existing single-window overload.
5. **Per-window options via an elaborated value form.** The simple form
   (value = mapping) covers most cases; the elaborated form (value =
   `{ mapping, minSamples? }`) handles per-window gates without bloating
   the common path.

```ts
byHost.rolling(
  {
    '1m':    { cpu_avg: 'avg', cpu_sd: 'stdev' },
    '200ms': { mapping: { cpu_samples: 'samples' }, minSamples: 5 },
  },
  { trigger },
);
```

## Worked example — anomaly density

The experiment's `packages/aggregator/src/aggregate.ts`, V7 (current), has
two rollings + a per-`(ts, host)` parts buffer + a microtask drain that
joins baseline and slice events:

```ts
const baselineStream = byHost.rolling(
  '1m',
  {
    cpu_avg: { from: 'cpu', using: 'avg' },
    cpu_sd:  { from: 'cpu', using: 'stdev' },
    cpu_n:   { from: 'cpu', using: 'count' },
  },
  { trigger },
);
const sliceStream = byHost.rolling(
  '200ms',
  { cpu_samples: { from: 'cpu', using: 'samples' } },
  { trigger },
);

// Per-(ts, host) parts buffer + microtask drain combining the two streams…
const pendingByTs = new Map<number, Map<string, Parts>>();
baselineStream.on('event', e => { partsFor(ts, host).baseline = ...; scheduleEmit(); });
sliceStream.on('event', e => { partsFor(ts, host).samples = ...; scheduleEmit(); });
// drain merges parts → HostTick → wire frame
```

Fused, the entire join goes away:

```ts
const fused = byHost.rolling(
  {
    '1m':    {
      cpu_avg: { from: 'cpu', using: 'avg' },
      cpu_sd:  { from: 'cpu', using: 'stdev' },
      cpu_n:   { from: 'cpu', using: 'count' },
    },
    '200ms': { cpu_samples: { from: 'cpu', using: 'samples' } },
  },
  { trigger },
);

fused.on('event', e => {
  // Both windows' columns on one event — no buffering, no drain.
  const tick: HostTick = assembleTick(
    e.key().begin(),
    e.get('host') as string,
    {
      cpu_avg: e.get('cpu_avg') ?? null,
      cpu_sd:  e.get('cpu_sd')  ?? null,
      cpu_n:   e.get('cpu_n')   ?? 0,
    },
    (e.get('cpu_samples') as ReadonlyArray<number>) ?? [],
    thresholds,
  );
  scheduleFrame(tick);
});
```

The aggregator's per-`(ts, host)` `pendingByTs` buffer, the
`partsFor` / `scheduleEmit` / `tryEmit` machinery, and the two-stream
reconciliation logic — all gone. The user code collapses to "build a
HostTick from one event and append to the per-tick frame."

This is a substantial readability win independent of the perf wins; the
buffer / drain dance was the single most mistake-prone part of step 4's
implementation review.

## TypeScript surface

Two existing overloads on `LivePartitionedSeries.rolling`:

```ts
rolling<const M extends AggregateMap<S>>(
  window: RollingWindow,
  mapping: M,
  options?: LiveRollingOptions & { trigger?: ClockTrigger },
): LiveSource<RollingSchema<S, M>>;

rolling<const M extends AggregateOutputMap<S>>(
  window: RollingWindow,
  mapping: M,
  options?: LiveRollingOptions & { trigger?: ClockTrigger },
): LiveSource<RollingOutputMapSchema<S, M>>;
```

Add a third overload for the keyed-form:

```ts
type FusedMappingValue<S extends SeriesSchema> =
  | AggregateMap<S>
  | AggregateOutputMap<S>
  | {
      mapping: AggregateMap<S> | AggregateOutputMap<S>;
      minSamples?: number;
    };

type FusedMapping<S extends SeriesSchema> = Readonly<
  Record<string, FusedMappingValue<S>>
>;

rolling<const FM extends FusedMapping<S>>(
  fused: FM,
  options: LiveRollingOptions & { trigger: ClockTrigger },
): LiveSource<FusedRollingSchema<S, FM>>;
```

Three things `FusedRollingSchema<S, FM>` needs to do at the type level:

### 1. Flat-merge per-window output columns into one schema

For each entry in `FM`, compute the per-window columns the way the existing
`RollingSchema<S, M>` and `RollingOutputMapSchema<S, M>` do (depending on
whether the value is `AggregateMap` or `AggregateOutputMap`), then union all
of them. The auto-injected partition column (`host`) is added once at the
front, not per window.

```ts
type ColumnsFromFusedValue<S, V> =
  V extends { mapping: infer M extends AggregateOutputMap<S> }
    ? RollingOutputMapColumns<S, M>
    : V extends { mapping: infer M extends AggregateMap<S> }
      ? RollingMappingColumns<S, M>
      : V extends AggregateOutputMap<S>
        ? RollingOutputMapColumns<S, V>
        : V extends AggregateMap<S>
          ? RollingMappingColumns<S, V>
          : never;

type AllFusedColumns<S, FM> = {
  [W in keyof FM]: ColumnsFromFusedValue<S, FM[W]>
}[keyof FM];

type FusedRollingSchema<S extends SeriesSchema, FM> = readonly [
  ColumnDef<'time', 'time'>,
  PartitionColumnFromS<S>,
  ...AllFusedColumns<S, FM>,
];
```

(Sketch only — actual implementation needs to handle the existing edge cases
in `RollingSchema` / `RollingOutputMapSchema`.)

### 2. Catch column-name collisions at the call site

If two windows define the same output column (`'1m': { cpu_avg: 'avg' }`
plus `'5m': { cpu_avg: 'avg' }`), today there's no way to enforce uniqueness
across separate `rolling()` calls. Fused shape can — by detecting duplicate
keys across the merged column list and emitting a `never` plus a branded
error type:

```ts
type CheckUniqueOutputs<FM> =
  /* if AllFusedColumns<S, FM> has duplicate names */
  ? { __error: `Duplicate output column '${string}' across windows` }
  : FM;
```

The user-facing experience: a clear compile-time error at the
`byHost.rolling({ ... })` call, naming the duplicate column. This is a
strict improvement over the status quo.

### 3. Constrain duration-string keys

Object keys are `string`. The library probably wants to narrow them to a
parseable `DurationInput`-shaped string at the type level:

```ts
type DurationString = `${number}${'ms'|'s'|'m'|'h'|'d'}`;

type FusedMapping<S extends SeriesSchema> = Readonly<
  Record<DurationString, FusedMappingValue<S>>
>;
```

Catches typos like `'1min'` at compile time.

## Implementation sketch

The cost story PR #19 documented:

- Per-event hop: doubled (`#routeEvent`, `_pushTrustedEvents`, listener
  fan-out).
- Per-tick partition-eviction pass: doubled (one pass per rolling, both fired
  by the shared trigger).
- Per-event reducer-state work: doubled.

Fused rolling shares all three:

### Single ingest pass

`LivePartitionedSyncRolling`'s `ingest(partitionKey, event)` runs once per
event regardless of how many windows the rolling carries. Inside, the
per-window state is a tight loop over N windows' reducer-add calls. For
N=2, this is roughly the same per-event work as N=1 plus a few extra
reducer `add()` invocations (~µs each) — much less than a full second
ingest pipeline pass.

The boundary check happens once: the trigger fires, the rolling computes
which windows had a boundary crossing (typically all of them at the same ts,
since they share the trigger), and emits a single merged event per partition.

### Per-window reducer state

Each window has its own ring buffer / reducer state per partition. This
allocation is unavoidable — it's the data the reducers operate on. But
running them in one tight loop in the same partition object's `ingest`
keeps cache locality high and avoids the cross-rolling indirection (going
back through `LivePartitionedSeries` → routing layer → second rolling → its
partition).

### Fused `#evictPartition`

`#evictPartition` is 8.8% self-time at ceiling in V7's profile (new in the
top-25 vs V6). Per-tick, per-partition, per-rolling cleanup. With fused
rolling that becomes per-tick, per-partition — a single pass that evicts
from all windows' ring buffers in one go. Should drop to ~4–5% self-time
based on the V7→V6 single-rolling baseline.

## Alternatives considered

### A. Array-of-window-specs

```ts
byHost.rolling(
  [
    { window: '1m',    output: { cpu_avg: 'avg' } },
    { window: '200ms', output: { cpu_samples: 'samples' } },
  ],
  { trigger },
);
```

Strictly worse readability — three layers of nesting (`window:` /
`output:` / individual columns) where two suffice. Doesn't catch
duplicate-window-key issues at the type level (objects do, by construction).

### B. Multi-window reducer

```ts
byHost.rolling(
  '1m',
  {
    cpu_avg: 'avg',
    cpu_samples: { from: 'cpu', using: 'samples', window: '200ms' },
  },
  { trigger },
);
```

Hides the second window inside the reducer-output spec. Smaller API surface
change. Two real downsides: (a) restricts inner windows to be ≤ outer
window (the outer is the rolling's "real" window; sub-windows must be
contained), which fits anomaly density's shape but is a real constraint; (b)
hides the cost — users can't tell from the call site they're getting two
windows of state. Hidden cost is the same problem the experiment's V6→V7
deltas surfaced; we shouldn't perpetuate it.

### C. Multi-output return tuple

```ts
const [baseline, slice] = byHost.rolling(
  [{ window: '1m', ... }, { window: '200ms', ... }],
  { trigger },
);
```

Each output stream is type-narrow. But every consumer has to do its own
per-`(ts, host)` join again — defeats the "user code collapses to one event
handler" win, which is half the value of the proposal.

### D. Status quo + partitioned `tap()` (separate primitive)

Earlier discussion (see `friction-notes/M3.5.md`'s `tap()` sketch): a
per-partition observer callback. `tap()` is a different solution to a
different problem — it's about getting per-event visibility cheaply, not
about fusing aggregations. It pairs well with fused rolling rather than
replacing it. A user with a slim observation use case (don't need a rolling,
just want to see events) would reach for `tap()`; a user with two
aggregations over the same source reaches for fused rolling.

## Open questions

### 1. Per-window trigger?

The proposal locks one trigger across all windows. That's by definition
how fused rolling saves — single boundary detection, single dispatch.
Users who want per-window cadence (e.g., "1m baseline emits once per
minute, 200ms slice emits every 200ms") fall back to two separate
`rolling()` calls and pay the V7 cost. Is that acceptable? My read: yes.
The use case for per-window cadence is rare enough that the simpler API
wins.

### 2. Per-window `minSamples`

Covered in the proposal — elaborated value form (`{ mapping, minSamples }`).
Question for the library agent: should `minSamples` at the top-level
(`options.minSamples`) still apply as a default, with per-window overrides?
Or is the top-level option deprecated for the keyed form? Probably the
former for consistency with the existing API.

### 3. Snapshot-side parity

`TimeSeries.rolling` should accept the same shape:

```ts
ts.rolling({
  '1m': { cpu_avg: 'avg' },
  '5m': { cpu_avg_long: 'avg' },
});
```

Less perf-critical (offline), but API parity matters for code that moves
between live and snapshot mode. The implementation is even simpler on
the snapshot side because there's no trigger.

### 4. Auto-injected partition column behaviour

The existing partitioned-rolling overload auto-injects `host` (or whatever
the partition column is) into the output schema, even if it's not in the
mapping. Fused should do the same — the partition column appears once at
the front of the merged output.

What if a window's mapping explicitly names the partition column? Today
that hits `LivePartitionedSyncRolling`'s collision check. Fused should
preserve that check across all windows: the partition column is auto-
injected and can't be overridden by any window's mapping.

### 5. `#evictPartition` win — quantify when prototyped

The 8.8% self-time at ceiling is the eviction pass running twice. Single-
pass eviction across N windows should drop to ~4-5%, but the measurement
to confirm is:

- Build a fused-rolling prototype on a topic branch
- Run `pnpm perf` (4 bench points + ceiling profile) at PR-#18 V7 commit
  for baseline
- Re-run on the prototype branch
- Profile-diff: the goal is `LivePartitionedSyncRolling.js` self-time
  approximately matches V6's ~8% range, ceiling throughput approximately
  recovers to V6's 258k/s

That's the acceptance bar.

## Acceptance criteria

When this lands, the experiment migrates `aggregate.ts` from V7 (two
rollings + per-`(ts, host)` join) to V8 (fused rolling, single event
handler). The expected PR will:

1. Drop `pendingByTs` / `partsFor` / `tryEmit` machinery
2. Collapse the two `byHost.rolling(...)` calls to one fused call
3. Re-run `pnpm perf` and confirm:
   - Ceiling throughput within 5% of V6's 258k/s (V7 was 209k/s, −19%)
   - 87k/s heap close to V6's 1617 MB (V7 was 1886 MB, +17%)
   - 9k/s heap stays at or below V7's 147 MB
4. Re-run profile-agg and confirm:
   - `LivePartitionedSyncRolling.js` self-time drops back to ~8-10% range
   - `#routeEvent` / `_pushTrustedEvents` / `ingest` inclusive time drop
     back to V6's range
5. Update `friction-notes/M3.5.md` to mark the fused-rolling entry resolved
   with the V6/V7/V8 perf comparison
6. Layer-2 adversarial review focuses on: window-collision detection at
   compile time, partition-column auto-injection across windows, eviction
   correctness when one window has events and another is empty.

## Prior art

- pond's existing single-window `partitionBy('host').rolling(window, mapping, opts)`
  is the obvious starting point. The fused shape is structurally a
  generalisation: `mapping` becomes `windowedMapping`.
- Other streaming libs (e.g., Kafka Streams, Flink) tend to use chained
  builders for multi-window aggregations — `.window(W1).aggregate(M1).window(W2).aggregate(M2)`.
  pond's "one schema, declarative mapping" idiom is closer to SQL-flavored
  relational reducers, and the keyed-object form fits that idiom better.
- The Rx-flavored `combineLatest([base$, slice$])` shape is the multi-
  output-stream alternative — explicitly avoided here because it forces
  consumer-side joining.

## Companion ask

The partitioned `tap()` primitive (per-partition observer callback)
discussed in `friction-notes/M3.5.md` is a separate, smaller library
change. It doesn't subsume fused rolling — they solve different problems —
but pairing them as one design pass is worthwhile because the
implementation can share infrastructure on the per-event dispatch path.

If only one ships first, fused rolling is the higher-value of the two for
the experiment's roadmap (M3.5 step 5+ will compose more rollings, and
M4's failure-mode tests at firehose rates depend on the cost being kept
down).
