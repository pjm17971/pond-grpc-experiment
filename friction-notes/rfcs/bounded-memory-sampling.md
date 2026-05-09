# RFC: Bounded-memory rolling via sampling — `live.partitionBy(...).sample({ stride: N })`

**Status: CLOSED — shipped in pond-ts 0.17.0.** See ["Resolution"](#resolution) at the bottom.
**Author:** the gRPC experiment agent (Claude)
**First raised:** PR #32's M3.5 finish-line work (the firehose-rate dashboard surfaced a pond rolling-state ceiling that's not addressable via retention)
**Origin friction note:** [`friction-notes/M3.5.md`](../M3.5.md) — "Bounded-memory rolling via sampling — RESOLVED in pond 0.17.0"
**Prototype:** [PR #33](https://github.com/pjm17971/pond-grpc-experiment/pull/33) — user-space stride filter at the gRPC ingest path, with measured numbers
**Library implementation:** [pond-ts#129](https://github.com/pjm17971/pond-ts/pull/129) — shipped in pond-ts 0.17.0
**Experiment integration:** this branch — replaces the prototype with `live.partitionBy('host').sample({ stride })` in the aggregate pipeline

## TL;DR

A chainable stream operator that thins events going into downstream consumers without affecting the parent series' length, listener fan-out, or upstream counters:

```ts
live
  .partitionBy('host')
  .sample({ stride: 10 })
  .rolling('5m', {                       // ← longer baseline, same memory
    cpu_avg: 'avg',
    cpu_sd: 'stdev',
    cpu_n: 'count',
    cpu_min: 'min',
    cpu_max: 'max',
  }, { trigger });
```

Two strategies (`{ stride: N }`, `{ reservoir: { size: K } }`), identity-on-schema typing, per-partition behaviour implicit when chained after `partitionBy`. The headline value is **decoupling baseline-window length from event rate** — operators consistently want longer rolling baselines for stability but get blocked at "1m because longer doesn't fit." Memory savings are a secondary win.

## Motivation

### The window-length wall (the user-facing case)

A streaming aggregator's rolling-window memory is `O(window_seconds × event_rate × per_partition_count)`. Operators want long windows for stability — `cpu_sd` over 5 minutes is a far more useful "is this host in a different regime than usual?" signal than `cpu_sd` over 1 minute, because the longer window has 5× more samples and 5× lower estimator variance under the same noise model.

The gRPC experiment's aggregator runs `live.partitionBy('host').rolling('1m', {...}, {trigger})` at firehose rates of 70k events/s × 80 partitions. That window holds 4.2M events in pond's per-partition deques (60s × 70k/s), summing to roughly 2.5 GB of resident state. A 5m baseline at the same rate is a **non-starter** — 21M events × 80 partitions × ~600 bytes/event ≈ 170 GB. The window length isn't a knob the operator can turn; it's pinned to whatever fits in the heap.

The retention story (the experiment's PR #29 shrank LiveSeries retention from 6m → 90s → 30s) doesn't address this. Retention bounds the parent `LiveSeries`' deque, but pond's rolling carries its own per-partition deque (correctly so — the rolling's window can outlive the source's retention). Shrinking retention saves ingest-buffer memory but doesn't touch the rolling's own state.

The physical limit is per-event memory × event count. To break the wall, you have to reduce one of those. `per-event` is already pretty lean (Welford's running-stats state, head-index amortised eviction, trusted-pipeline routing — all shipped between pond 0.13 and 0.15). `event count` is what sampling addresses.

### The math says it works

For numeric reducers (`avg`, `stdev`, `min`, `max`, `count`), the standard error of the rolling mean is `sd / sqrt(N)`. At 70k events/s × 60s = 4.2M events the SE is two orders of magnitude below the per-event noise floor. Sampling 1-in-10 cuts N to 420k — the SE grows √10 ≈ 3.2× but stays an order of magnitude below the noise floor, so the visible stability of `cpu_avg` / `cpu_sd` is unchanged.

The experiment's measurement (PR #33, full firehose × stride=10):

| metric | un-sampled (baseline) | sampled (stride=10) | ratio |
|---|---|---|---|
| `cpu_avg` (api-1) | 0.5446 | 0.5575 | within burst-walk drift |
| `cpu_sd` (api-1) | 0.1166 | 0.1176 | identical to 3 d.p. |
| `cpu_n` per host | 53,282 | 5,278 | 10× (matches stride) |

Anomaly counts scale linearly with sample rate; recovering precision is multiplication. For `top-k` and `unique` reducers the story is more complicated (samples could miss a singleton that crosses a threshold), but for the dominant numeric-reducer case sampling is statistically equivalent at any rate where N stays comfortably above 100.

### Memory savings are real but bounded

The prototype on PR #33 measured:

| uptime | un-sampled rss / heap | sampled (stride=10) rss / heap |
|---|---|---|
| 30 s | 1.1 GB / 0.9 GB | 0.6 GB / 0.4 GB |
| 60 s | 2.0 GB / 1.2 GB | 0.9 GB / 0.7 GB |
| 90 s | 2.5 GB / 2.3 GB | 1.5 GB / 1.3 GB |
| 120 s | 3.6 GB / 3.3 GB | 1.8 GB / 1.6 GB |
| 150 s | 4.3 GB / 2.5 GB † | 2.1 GB / 1.8 GB |
| ~13 min | OOM @ 8 GB ceiling | comfortable |

† 150 s un-sampled heap dropped from 3.3 → 2.5 GB after a major GC; rss stayed at 4.3 GB pre-reclaim.

About **2× heap reduction for 10× event reduction**. Two reasons it's not 10× linear:

1. **Per-partition fixed costs don't scale with events.** Pond's rolling holds per-partition deque metadata, reducer state objects, fused-window bookkeeping. With 80 partitions × ~5 reducers each, that's ~400 small objects whose count is invariant to stride. At sampled rates those fixed costs become a larger fraction of total memory.
2. **The aggregator's user-space `arrivalTimes` Map** (latency tracking) accumulates a per-true-event entry upstream of the sample filter. After ~13 min at firehose it hits V8's `Map maximum size exceeded` ceiling. That's a prototype-side issue (the library version moves the work into pond and avoids it), but it limited the comparison window to 150 s.

A library implementation would do better than the prototype — no double-counter coordination, no per-event Map overhead in user code — but the per-partition floor is real. The savings are a function of `(per-event memory) / (per-partition fixed memory)` for each consumer's workload.

### The bigger story is window length, not heap-cost

A 5m baseline at 70k/s × 1-in-50 stride is ~3.4 GB — fits a Node heap. You get **5× the temporal stability** (the more-stable baseline operators want) for the same memory budget as the current 1m × full-rate setup. Sampling decouples window length from event rate; pond's existing rolling chains them.

That's the user-facing case to lead with on a roadmap. "30% lower aggregator memory" is a deploy-cost story; "5× more stable cluster CPU baseline at the same memory" is a product story.

## Proposal

### API shape

A new chainable `sample` operator parameterised by a strategy:

```ts
type SampleStrategy =
  | { stride: number }                             // deterministic 1-in-N
  | { reservoir: { size: number } };               // unbiased random K-of-N

interface LiveSeries<S>     { sample(s: SampleStrategy): LiveView<S>; }
interface LivePartitionedSeries<S, K, ByCol>
  { sample(s: SampleStrategy): LivePartitionedView<S, K, ByCol>; }
interface LiveView<S>       { sample(s: SampleStrategy): LiveView<S>; }
interface LivePartitionedView<S, K, ByCol>
  { sample(s: SampleStrategy): LivePartitionedView<S, K, ByCol>; }

interface TimeSeries<S>            { sample(s: SampleStrategy): TimeSeries<S>; }
interface PartitionedTimeSeries<…> { sample(s: SampleStrategy): PartitionedTimeSeries<…>; }
```

Type signature is **identity-on-schema** — `sample` doesn't transform the row shape, it thins the stream. No `AggregateMap`-style mapping, no friction at the call site, slots into the same lineup as `filter` / `smooth` / `partitionBy`.

### Per-partition is implicit when you chain after `partitionBy`

The placement matters. `live.partitionBy('host').sample({ stride: 10 })` thins each host's stream independently. `live.sample({ stride: 10 }).partitionBy('host')` thins the input as a single global stream before partitioning. Both are valid and have different semantics; placement encodes the intent.

This is the design call the API has to get right. The experiment's prototype landed on the wrong default twice — first because the chainable form didn't exist (the prototype thinned at gRPC ingest, pre-partition), then because a global stride against a structured input stream silently produced a sample-biased rolling. See ["The bias case"](#the-bias-case) below.

### Two sampling strategies

**Stride** (`{ stride: N }`):
- Deterministic — keep events whose per-stream counter is a multiple of N.
- Cheap: O(1) per event, no RNG, no allocation.
- Uniform-over-time: the stream's representativeness is preserved at every moment.
- Right default for sliding-window stats. The window's age spans a uniform sample of events.

**Reservoir** (`{ reservoir: { size: K } }`):
- Unbiased random K-of-N (Vitter's Algorithm R or similar).
- Useful for non-windowed reductions where total-population representativeness matters more than recent-window representativeness.
- Loses temporal locality: under sliding-window eviction, reservoir contents skew toward older events as new events compete for fixed K slots.
- Shouldn't be the default for `rolling`; document the time-skew explicitly.

For the sliding-window case the experiment cares about, stride is the right answer. Reservoir is included for completeness and for `aggregate` / non-rolling consumers.

### Counts and metadata

Reducer outputs become observed counts, not true counts. The library has options:

**Option A — observed-only:** Reducer outputs (`'count'`, `'sum'`, `'samples'`, `topN`) report what actually flowed through the consumer. Users multiply by `1/sample_rate` themselves if they want a true-count estimate. Simplest. Documents the relationship in `sample`'s docstring.

**Option B — emit both:** Reducer outputs gain a parallel `_observed` field for the sampled count and a `_estimated` field for the scaled-up estimate. Library threads sample rate through reducer state. More invasive. Better for consumers who shouldn't have to know they're working with sampled data.

**Option C — opt-in metadata:** A `sample({ stride: N, exposeRate: true })` variant that adds a `_sample_rate` column to downstream rows. Consumers project it through if they want it.

I'd lean **A** for v1 — additive surface, explicit, no surprises in existing consumer code. Defer B to a v2 once the primitive ships and we have feedback on what consumers actually do with sampled counts.

### Counts upstream of `sample` stay honest

The chainable placement is the right call for this too. `live.stats().ingested` (post-0.16.0) and `live.on('batch', cb)` are upstream of any `.sample(...)` op — they continue to count true throughput. Only consumers downstream of the sample see the thinned stream. The wire's `events_ingested_total` global doesn't lie; only the rolling's `cpu_n` does (and the docstring says so).

## The bias case

The experiment's prototype hit this and it's the strongest argument for the per-partition-default API placement. Worth a section.

The producer emits one event per host per setInterval tick in a fixed host order. At `EVENTS_PER_SEC=10000 HOST_COUNT=80` and Node's setInterval clamp at 1ms, that's 80 events per batch at the same `ts`, ordered `[api-1, api-2, …, api-80]`. The first version of the prototype used a single global stride counter:

```ts
if (sampleStride === 1 || sampleCounter % sampleStride === 0) {
  rows.push(...);
}
sampleCounter += 1;
```

At stride=10, this keeps events at indices 0, 10, 20, … of every batch — which (because of the fixed host order) means it keeps **the same 8 hosts from every batch and drops the other 72 entirely**. The aggregate-stream wire showed `cpu_n ≈ 53k` (un-sampled value) for the 8 kept hosts and zero entries for the rest. The dashboard's host pills only listed `api-1, api-11, api-21, …, api-71`. cpu_avg / cpu_sd looked plausible for the 8 hosts that did exist; nothing in the cluster headline screamed "you are missing 90% of your cluster."

The fix in the prototype was a `Map<host, counter>` with per-host counters — i.e., reconstructing-by-hand exactly what `partitionBy('host').sample({stride:10})` does for free. Once each host's stream got its own counter, `cpu_n` dropped to the expected ~5,300/host, every host was represented, and the dashboard rendered identically to un-sampled.

This failure mode is what the proposed API placement avoids. Chaining `sample` after `partitionBy` makes per-stream-thinning the natural shape; the library knows which column is the partition key, so the per-stream behaviour is implicit. Chaining `sample` *before* `partitionBy` is a global stride and would have the same bias if the upstream order is structured.

The recommendation: **default to refusing global sample on a stream that has structure visible to the library**, or document the failure mode loudly enough that the per-partition placement is the obvious choice. Worth considering whether the type system can guide this — e.g., `sample()` on `LivePartitionedSeries` is the well-defined case, `sample()` on `LiveSeries` (pre-partition) carries a clearly-named risk in the docstring or even gates behind an `unsafeGlobal: true` flag.

## Properties

- **Identity-on-schema.** The output schema equals the input schema. Sampling is a stream content operator, not a transformation.
- **Idempotent under composition.** `live.sample({stride: 2}).sample({stride: 5})` is equivalent to `live.sample({stride: 10})` — though probably not worth optimising; chaining samplers is rare and the slow path is just two filter passes.
- **Eviction-transparent.** When the upstream evicts an event, the sampled view evicts the same event if it had passed through. Same head-index pattern as the rest of pond's eviction.
- **Listener-side correct.** A `LiveView` returned by `sample` fires `'batch'` / `'evict'` / `'event'` listeners only for events that pass the sample. Subscribers downstream of sample don't see the dropped events.
- **Backpressure-neutral.** Sampling is a per-event filter; it doesn't accumulate. No queuing, no lag introduced.
- **Trigger-compatible.** `sample` works as expected in front of `rolling`, `aggregate`, and trigger-driven streams. The trigger fires on its own clock, not per source event, so reducing event count doesn't affect trigger cadence.

## Migration

Strictly additive. No existing pond surface changes meaning. Consumers who don't use `sample` see no behavioural change.

For pond itself:
- `LiveSeries.sample` → returns a new `LiveView<S>` (similar shape to `LiveSeries.filter` if that exists, or new ground if not).
- `LivePartitionedSeries.sample` → returns `LivePartitionedView<S, K, ByCol>`. The `ByCol` generic threads through (same pattern as `partitionBy`'s 0.15.1 fix).
- Per-partition rolling overloads on the partitioned view automatically work — pond just sees a thinner stream of events into the rolling's per-partition state.
- Snapshot-side `TimeSeries.sample` → returns `TimeSeries<S>`. Useful for `series.sample(...).aggregate(...)` consumers and for parity.

Per-event cost: O(1) — increment one counter (per partition for partitioned variants, one global for non-partitioned), test against the stride or run reservoir's substitute. Reservoir is slightly more expensive (RNG per event, occasional array swap) but still O(1).

## Open questions

1. **Should pre-partition `sample` exist at all?** The bias case argues for forbidding `live.sample(...)` outside very specific use cases (homogeneous streams). But it might be a useful escape hatch for streams that aren't partitioned yet. **Recommendation:** allow it but require the user to acknowledge the caveat — either via an explicit `unsafeGlobal: true` strategy field, a `live.sampleGlobal(...)` named alias, or a runtime-warning-on-first-call when the stream has more than one partition column visible.

2. **Sample-rate metadata in reducer outputs (Option A / B / C above).** Decision-required for the API shape. Lean A for v1.

3. **Reservoir under sliding eviction.** Eviction of "the oldest event" is well-defined in stride sampling (the same event the upstream just evicted). In reservoir sampling, the oldest event might not be in the reservoir at all, and the reservoir might contain events newer than the eviction point. Spec needs to be clear on what reservoir-sampled rolling state looks like under retention. Likely: reservoir holds K random events from "what has been seen so far"; eviction removes one event from the reservoir if it was in it, otherwise no-ops. May skew toward stale state under heavy eviction.

4. **Snapshot-side `TimeSeries.sample` use cases.** Mostly-batch consumers will use `aggregate(seq, mapping)` for downsampling instead. Is `TimeSeries.sample` a separate primitive worth shipping, or is it subsumed by `aggregate`? **Recommendation:** ship for parity (small surface, doesn't conflict with anything), but don't lead the docs with it.

5. **Compatibility with the streaming-roadmap RFC's window/buffer semantics.** Worth checking against the buffer-as-window persona work in pond 0.16. Sampling shouldn't conflict — a buffer-as-window persona that wants stable stats over a long buffer benefits from sampling exactly the same way the rolling-window persona does.

## Citations

- gRPC experiment, M3.5 finish-line work — PR [#32](https://github.com/pjm17971/pond-grpc-experiment/pull/32) / [#33](https://github.com/pjm17971/pond-grpc-experiment/pull/33).
- M3.5 friction note: ["Bounded-memory rolling via sampling"](../M3.5.md#bounded-memory-rolling-via-sampling--livepartitionbysamplestride-n).
- Streaming-roadmap RFC (library-side, ack'd by experiment user 2026-05-08): the buffer-as-window persona work in pond 0.16 sets the design pattern this RFC follows (chainable, additive, identity-on-schema where possible).
- Statistical-equivalence numbers measured at firehose: 70k events/s × 80 partitions × 1m baseline, stride=10 — see [`friction-notes/M3.5.md`](../M3.5.md) and PR #33's body.
- Per-partition memory floor analysis: 80 partitions × ~5 reducers each ≈ 400 fixed objects regardless of stride. Per-event vs per-partition memory ratio is the single number that determines a given workload's effective heap reduction under sampling.

## Resolution

**Closed in pond-ts 0.17.0** ([PR #129](https://github.com/pjm17971/pond-ts/pull/129) / [release](https://www.npmjs.com/package/pond-ts/v/0.17.0), 2026-05-08). The library-side work shipped the API shape this RFC proposed, with the same chained-after-`partitionBy` placement and the same per-stream-thinning semantics. The 0.17.0 changelog cites this RFC by URL.

**What shipped (mapping back to this RFC's TL;DR):**

| RFC asked for                                                          | 0.17.0 shipped                                                                           | Notes                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live.partitionBy('host').sample({ stride: N }).rolling(...)`          | exactly that                                                                             | The keyed-form fused rolling from 0.15.0 composes cleanly downstream.                                                                                                                                                                                                          |
| Identity-on-schema typing                                              | `LiveView<S>` returned                                                                   | Chainable surface (`filter`, `rolling`, `reduce`, `select`, `map`, `diff`, `rate`, `cumulative`, `fill`) immediately available downstream.                                                                                                                                     |
| Per-partition state implicit when chained after `partitionBy`          | yes — closure-captured counter inside the `LiveView<S>`                                  | The bias-trap worked example from this RFC is now in pond's JSDoc on `LiveSeries.sample` / `LiveView.sample` with the `partitionBy(...).sample(...)` recommendation.                                                                                                           |
| Counters + listeners upstream of the sample                            | yes — `live.stats().ingested` and `live.on('batch', cb)` see true throughput             | Resolves the prototype's "counts post-sample" caveat without any wire-format change. The aggregator's globals tick now reports the actual gRPC firehose under any stride.                                                                                                      |
| Reservoir variant                                                      | snapshot side only (`TimeSeries`, `PartitionedTimeSeries`); live side queued for v0.18.0 | Algorithm R's random-slot replacement produces non-prefix evictions, which the existing live-eviction protocol can't model. The RFC's `'evict' \| 'replace'` proposal landed in 0.17.0's deferred section pretty much verbatim, blocked on Phase 4.5 milestone A's `LiveChange` channel. |
| Sample-rate metadata in reducer outputs (Option A / B / C)             | Option A                                                                                 | "User-space scaling": the consumer multiplies `count` / `sum` outputs by `stride` if they want true firehose totals from the rolling. The aggregator does this for nothing right now (it doesn't surface count/sum from the per-host rolling on the wire), but the design decision matches the RFC's recommendation. |
| Pre-partition `sample` allowed but warning-attached                    | allowed; multi-entity bias trap documented in JSDoc                                      | An earlier iteration of #129 shipped a type-level `unsafeGlobal: true` token; pulled during review for consistency with how every other stateful live operator handles the same multi-entity consideration. JSDoc warning is the same answer the other operators already give. |

**What this RFC proposed that didn't ship (yet):**

- **Live-side reservoir.** Deferred to v0.18.0+ behind Phase 4.5 milestone A's `LiveChange` channel. The library agent's reasoning matches this RFC's open question #3: random-slot replacement needs an exact-removal eviction channel that doesn't exist yet. Workaround per the 0.17.0 docs: `live.toTimeSeries().sample({ reservoir })` for the visualization-shaped case.

**What changed during the round-trip that this RFC didn't anticipate:**

- The `unsafeGlobal: true` strategy field (open question #1) was originally accepted into #129 then pulled during review. Reasoning: every other stateful live operator (`rolling`, `aggregate`, `fill`, `diff`, `rate`, `cumulative`, `pctChange`, `reduce`) gates the same multi-entity bias trap with a JSDoc warning rather than a type-level token, so a special token here would have been inconsistent. The JSDoc warning is now the consistent shape across the surface.

**The integration on the experiment side** (this branch):

- Replaced the prototype's per-host stride sampler at the gRPC ingest hop (`Map<string, number>` counters in `ingest.ts`) with `live.partitionBy('host').sample({ stride })` in the aggregate pipeline. Bench numbers will land alongside the integration PR.

The friction → prototype → RFC → library → integration loop took two library releases (0.16.x for the supporting infrastructure — `partitionBy` auto-injection, `stats()` accessor — and 0.17.0 for the operator itself) and produced a piece of pond surface that closes a class of workloads the experiment couldn't otherwise sustain.
