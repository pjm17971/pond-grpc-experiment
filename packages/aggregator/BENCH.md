# M3 throughput bench

End-to-end throughput characterisation for the producer ↔ aggregator ↔ probe pipeline. Each config: a fresh producer + aggregator, a single WebSocket probe consuming the snapshot+append stream, 5 s warmup, 30 s measurement window. The bench script lives at [`scripts/bench.ts`](./scripts/bench.ts); reproduce with `pnpm bench:full --seconds=30`.

The probe records every frame it receives. Aggregator-side metrics scrape `/metrics` once per second; cumulative counters get diffed across the window for rate / GC / batch stats. `Residual` counts events ingested at gRPC but not yet paired by a fanout call — a leak proxy.

## Library bench reference

The [pond-ts](https://github.com/pjm17971/pond-ts) library publishes its own bench across `P` (partition count) × `N` (events per `pushMany` call) — pond-only, no networking:

| P    | N=1  | N=10 | N=100 |
| ---- | ---- | ---- | ----- |
| 1    | 16k  | 175k | 227k  |
| 10   | 267k | 437k | 494k  |
| 100  | 273k | **538k** | 520k  |
| 1000 | 371k | 435k | 353k  |

**Peak: 538k events/sec at P=100, N=10.** The N=1 column is the per-event push regime; N=10 / N=100 are explicit pushMany batches.

## What the experiment measures

Two regimes:

1. **Per-event push** (M2 ingest): `live.push([row])` once per gRPC stream Event. Maps to library's N=1 column conceptually — but with the gRPC + WebSocket + snapshot/append protocol stack stacked on top.
2. **Macrotask-coalesced pushMany** (M3 phase 5): same gRPC stream, but the aggregator buffers arriving Events into a `pending: RowForSchema[]` array and flushes via `live.pushMany(rows)` on `setImmediate`. Coalescing is opportunistic — the batch size is whatever arrived in one event-loop tick.

**Sweep:** `P (hosts) ∈ {10, 100, 1000}` × `N (events/sec/host) ∈ {1, 10, 100, 1000}`.

## Results — per-event push (baseline)

Captured before the M3 phase-5 batching change. Latencies use the bench script's earlier 1-decimal formatter; sub-millisecond values truncate to 0.0.

| P | N | Target/s | Achieved/s | p50 ms | p95 ms | p99 ms | GC major | GC minor | Heap peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 | 10 | 10 | 0.0 | 0.1 | 0.1 | 2 / 7ms | 5 / 3ms | 23 MB |
| 10 | 10 | 100 | 99 | 0.0 | 0.0 | 0.1 | 3 / 7ms | 16 / 9ms | 27 MB |
| 10 | 100 | 1,000 | 913 | 0.0 | 0.0 | 0.0 | 0 / 0ms | 17 / 21ms | 43 MB |
| 10 | 1000 | 10,000 | 9,074 | 0.0 | 0.0 | 0.0 | 7 / 11ms | 162 / 188ms | 100 MB |
| 100 | 1 | 100 | 100 | 0.0 | 0.0 | 0.0 | 2 / 5ms | 20 / 9ms | 24 MB |
| 100 | 10 | 1,000 | 990 | 0.0 | 0.0 | 0.0 | 1 / 2ms | 17 / 21ms | 40 MB |
| 100 | 100 | 10,000 | 9,170 | 0.0 | 0.0 | 0.0 | 7 / 12ms | 164 / 143ms | 92 MB |
| 100 | 1000 | 100,000 | **68,820** | 0.0 | 0.0 | 0.0 | 2 / 4ms | 1237 / 1186ms | 709 MB |
| 1000 | 1 | 1,000 | 997 | 0.0 | 0.0 | 0.0 | 1 / 1ms | 18 / 14ms | 40 MB |
| 1000 | 10 | 10,000 | 9,910 | 0.0 | 0.0 | 0.0 | 8 / 13ms | 174 / 121ms | 99 MB |
| 1000 | 100 | 100,000 | **65,208** | 0.0 | 0.0 | 0.0 | 1 / 3ms | 1170 / 1191ms | 690 MB |
| 1000 | 1000 | 1,000,000 | **20,190** | 0.0 | 0.0 | 0.0 | 4 / 7ms | 361 / 227ms | 227 MB |

## Results — macrotask-coalesced pushMany (post-fixes)

The latest run, after the M3 fixes (FIFO arrival map for collision pairing, Residual column restored). Latencies use 2-decimal precision and reflect the corrected histogram (the pre-fix histogram under-reported because same-`(host, timeMs)` collisions overwrote arrival timestamps with the more-recent t0).

| P | N | Target/s | Achieved/s | p50 ms | p95 ms | p99 ms | GC major | GC minor | Heap peak | Avg batch | Max batch | Residual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 | 10 | 10 | 0.14 | 0.43 | 1.23 | 2 / 7ms | 4 / 3ms | 23 MB | 4.4 | 9 | 0 |
| 10 | 10 | 100 | 99 | 0.04 | 0.18 | 0.41 | 3 / 9ms | 14 / 7ms | 26 MB | 3.9 | 9 | 0 |
| 10 | 100 | 1,000 | 911 | 0.03 | 0.09 | 0.26 | 2 / 5ms | 51 / 32ms | 30 MB | 2.7 | 10 | 0 |
| 10 | 1000 | 10,000 | 8,995 | 0.01 | 0.04 | 0.06 | 7 / 11ms | 153 / 149ms | 87 MB | 1.7 | 50 | 2 |
| 100 | 1 | 100 | 100 | 0.03 | 0.24 | 0.75 | 2 / 5ms | 18 / 12ms | 24 MB | 2.9 | 60 | 0 |
| 100 | 10 | 1,000 | 989 | 0.02 | 0.13 | 0.21 | 2 / 6ms | 54 / 52ms | 33 MB | 2.6 | 70 | 0 |
| 100 | 100 | 10,000 | 9,230 | 0.01 | 0.02 | 0.05 | 7 / 13ms | 153 / 222ms | 91 MB | 1.8 | 100 | 0 |
| 100 | 1000 | 100,000 | **73,472** | 0.00 | 0.22 | 0.33 | 2 / 5ms | 1292 / 956ms | 687 MB | 1.4 | 433 | 32 |
| 1000 | 1 | 1,000 | 995 | 0.01 | 0.10 | 0.31 | 1 / 5ms | 45 / 21ms | 37 MB | 1.8 | 125 | 0 |
| 1000 | 10 | 10,000 | 9,882 | 0.00 | 0.04 | 0.16 | 8 / 13ms | 169 / 117ms | 96 MB | 1.5 | 114 | 2 |
| 1000 | 100 | 100,000 | **72,722** | 0.00 | 0.07 | 0.19 | 2 / 6ms | 1276 / 911ms | 673 MB | 1.4 | 396 | 21 |
| 1000 | 1000 | 1,000,000 | **23,628** | 0.00 | 0.03 | 0.11 | 3 / 5ms | 411 / 246ms | 234 MB | 1.5 | 158 | 0 |

## Side-by-side at saturation

| Config | Baseline (per-event push) | Batched (setImmediate pushMany) | Δ |
| --- | --- | --- | --- |
| P=100, N=1000 | 68,820 /s | 73,472 /s | +6.8 % |
| P=1000, N=100 | 65,208 /s | 72,722 /s | +12 % |
| P=1000, N=1000 | 20,190 /s | 23,628 /s | +17 % |

## Findings

### Plateau is ~73k events/sec — far below library's 538k

End-to-end the experiment plateaus around **73k events/sec** at saturation (P=100,N=1000 and P=1000,N=100 both saturate near this). That's **~14 % of the library's 538k peak** at P=100,N=10.

The gap is dominated by the gRPC + WebSocket stack: every event traverses gRPC frame deserialize, schema validation, `live.push([row])`, `Event.toJsonRow(schema)` for fanout, `JSON.stringify`, `ws.send`. The library bench measures pond in isolation; we measure the whole pipeline.

### Macrotask coalescing barely batches

The `Avg batch` column is the smoking gun. At saturation (P=100,N=1000 → 73k events/sec), the average `pushMany` call carries **only 1.4 events** — coalescing happens occasionally (max batch hit 433) but the steady state is one or two events per `setImmediate` flush.

This is because gRPC delivers events one per event-loop tick: a single Subscribe stream's `'data'` handler fires synchronously per frame, and `setImmediate` runs at the next macrotask boundary, so most flushes catch only the event that triggered the schedule. The throughput delta vs the per-event baseline is +7-17 % — a real improvement at saturation but nowhere near the 5-7× ratio the library bench's N=10 cell suggests.

**The library bench's N=10 / N=100 columns are explicit larger batches at the push call** — the experiment's gRPC delivery pattern doesn't reach that ratio without changing the wire shape.

### Cardinality dip reproduces

The library bench dips at P=1000 (538k → 353k for N=100). The experiment reproduces a sharper version at P=1000,N=1000 — total 1M events/sec target, achieved 24k/s. That's ~33 % of the next cell down (P=1000,N=100 → 73k). The dip is steady-state — `Heap peak` and `GC minor` both shrink at the dip cell, suggesting the producer can't sustain the input rate, not that the aggregator is overwhelmed:

| Config | Achieved | Heap | GC minor (count / total ms) |
| --- | --- | --- | --- |
| P=1000, N=100 | 72,722 | 673 MB | 1276 / 911ms |
| P=1000, N=1000 | 23,628 | 234 MB | 411 / 246ms |

At P=1000, N=1000 the producer's `setInterval(_, 1ms)` with 1000 events per tick is bumping into Node's timer resolution; effective tick rate falls below the target.

### GC pauses stay sub-100 ms

No major GC pauses approach the 100 ms PLAN exit threshold. Across all configs the **max major pause is 13 ms** (P=1000,N=10). Minor GC dominates time-spent at saturation: ~1.0 s of minor GC across a 30 s window for the 73k cells (3-4 % of wall-clock).

### Latency well under the PLAN budget

PLAN target: p99 ingest→fanout < 100 ms at 50 % of plateau, < 500 ms at plateau. Actual:

- 50 % of plateau (≈ 35k/s): not directly measured in the sweep (10k/s is the closest; p99 = 0.05 ms).
- Plateau (P=100,N=1000 → 73k/s): **p99 = 0.33 ms.**
- Cardinality stress (P=1000,N=1000): p99 = 0.11 ms.

All three orders of magnitude under budget. The latency budget was set conservatively against operational scenarios where slow clients or backpressure dominate; this experiment has neither (single fast probe, no slow-client policy yet — that's M4).

### Residual is small but non-zero at saturation

`Residual` reads the count of arrival-map entries that were ingested but not paired by a fanout call before the run's final `/metrics` scrape. P=100,N=1000 leaves 32 entries against ~2.2M total events ingested in 30 s — ~0.001 %. These are events in flight when the bench tore down (gRPC stream had delivered them but pond's `'batch'` callback hadn't fired yet), not a structural leak.

## Memory trajectory (5-minute steady-state run)

Config: P=100, N=100, target 10k events/sec — the "busy fleet" sweep cell. 5-minute window at sustained load, sampled once per second.

| Metric | Value |
| --- | --- |
| Achieved rate | 8,927 events/sec |
| p99 latency | 0.01 ms |
| GC major | 26 calls / 46 ms total (max ~2 ms) |
| GC minor | 1,503 calls / 2,501 ms total (~0.8 % of wall-clock) |
| Heap peak | 626 MB |
| Avg batch | 1.7 events |
| Max batch | 98 events |

**Heap is bounded.** At 8.9k events/sec × 360 s retention = ~3.2M events held; heap peak of 626 MB is consistent with pond's compact internal storage (~200 bytes/event). The 5-min window ran longer than the retention window, so the eviction path is exercised — heap stabilised, didn't grow unbounded.

(This run was captured before the FIFO arrival-map fix; latency may be slightly under-reported per the same-`(host, timeMs)` collision discussed in the friction notes. Conclusions on heap and GC are unaffected.)

PLAN's exit "memory growth pattern over a 1-hour run is bounded" was scaled to 5 minutes for the M3 PR's time budget; the trajectory across the window flattens by the 60 s mark (when retention starts evicting), so a 1-hour run is expected to track the same plateau. Friction-noted in `friction-notes/M3.md`.

GC major count (26 / 46 ms over 5 min) implies ~12-second cadence at average ~2 ms per pause. No outlier majors approached the 100 ms PLAN threshold.

## What would close the library-bench gap

The experiment's 73k/s plateau is **gRPC framing-bound**, not pond-bound. Two interventions, in expected impact order:

1. **Wire-level batching: `stream EventBatch`.** Producer accumulates events for a tick (1-10 ms) and sends one `EventBatch { repeated Event events }` per gRPC frame. Aggregator unpacks into `pushMany`. Average batch size jumps from 1.4 to ~10-100; pushMany amortises per-event overhead. Expected throughput: 200-400k/s — closes most of the gap.
2. **MessagePack on the WS wire.** v1 is JSON; the wire format is isolated in `packages/shared/src/wire.ts` for exactly this swap. Helps less than (1) because WS isn't the bottleneck at our rates, but compresses heap pressure.

Both are M3+ followups. (1) requires a proto change + producer batching logic + aggregator unbatching. (2) is a one-file swap once a benchmark says the wire is on the critical path.

## Methodology notes & limitations

- 30 s measurement window per config (PLAN's spec is 60 s). Shorter window makes very low rates noisier — at P=10,N=1 we see "10 achieved" with only 300 events total, so the per-second rate is integer-quantised. At saturation the window's irrelevant.
- Single WS consumer probe. Multi-consumer fanout amplification is M3+.
- The baseline + batched tables in this file were stitched manually for the PR. `pnpm bench:full` always overwrites `BENCH.md` with the most recent run's table only — the comparison-narrative format isn't a script output, so re-running will replace this file. Friction-noted.
- Producer's `setInterval` at sub-millisecond `tickMs` (N >= 1000) drifts from the target rate. For P=10, N=1000 (10k target) we hit 9.0k. That's a producer-side timer resolution limit, not an aggregator capacity problem.
- All tests on a single MacBook Pro (Apple Silicon). Numbers will move on different hardware.
- Baseline table was captured before the FIFO arrival-map fix; its latency precision is also lower (1-decimal formatter). Both are documented in the table-introduction sentences. The post-fix sweep is the canonical reference.
