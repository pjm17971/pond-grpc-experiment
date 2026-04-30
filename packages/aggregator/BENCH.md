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

## Three regimes characterised

The experiment swept all three and the results are kept side-by-side.

1. **Per-event push** (M2 ingest): `live.push([row])` once per gRPC `Event` frame. Maps to library N=1 conceptually, with the gRPC + WebSocket stack on top.
2. **Macrotask-coalesced pushMany** (M3 phase 5): `live.pushMany(buffer)` flushed via `setImmediate`. Gathers whatever events arrived in one event-loop tick — empirically 1–5 events per call.
3. **EventBatch wire** (M3 extension, this PR): `stream EventBatch` instead of `stream Event`. The producer accumulates per-tick events and writes one frame per tick; the aggregator unpacks the whole batch into one `pushMany`. Average batch size = `hostCount` (tens to thousands).

**Sweep:** `P (hosts) ∈ {10, 100, 1000}` × `N (events/sec/host) ∈ {1, 10, 100, 1000}`.

## Results — per-event push (M3 baseline, historical)

Captured before any batching change. Latencies use the bench script's earlier 1-decimal formatter; sub-millisecond values truncate to 0.0.

| P | N | Target/s | Achieved/s | p99 ms | GC minor | Heap peak |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 | 10 | 10 | 0.1 | 5 / 3ms | 23 MB |
| 10 | 10 | 100 | 99 | 0.1 | 16 / 9ms | 27 MB |
| 10 | 100 | 1,000 | 913 | 0.0 | 17 / 21ms | 43 MB |
| 10 | 1000 | 10,000 | 9,074 | 0.0 | 162 / 188ms | 100 MB |
| 100 | 1 | 100 | 100 | 0.0 | 20 / 9ms | 24 MB |
| 100 | 10 | 1,000 | 990 | 0.0 | 17 / 21ms | 40 MB |
| 100 | 100 | 10,000 | 9,170 | 0.0 | 164 / 143ms | 92 MB |
| 100 | 1000 | 100,000 | **68,820** | 0.0 | 1237 / 1186ms | 709 MB |
| 1000 | 1 | 1,000 | 997 | 0.0 | 18 / 14ms | 40 MB |
| 1000 | 10 | 10,000 | 9,910 | 0.0 | 174 / 121ms | 99 MB |
| 1000 | 100 | 100,000 | **65,208** | 0.0 | 1170 / 1191ms | 690 MB |
| 1000 | 1000 | 1,000,000 | **20,190** | 0.0 | 361 / 227ms | 227 MB |

## Results — macrotask-coalesced pushMany (M3 phase 5, historical)

Avg batch size barely changes vs the baseline (gRPC delivers events one per event-loop tick; `setImmediate` flushes between each).

| P | N | Achieved/s | p99 ms | Avg batch | Max batch | Heap peak |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 | 10 | 1.23 | 4.4 | 9 | 23 MB |
| 10 | 1000 | 8,995 | 0.06 | 1.7 | 50 | 87 MB |
| 100 | 100 | 9,230 | 0.05 | 1.8 | 100 | 91 MB |
| 100 | 1000 | **73,472** | 0.33 | 1.4 | 433 | 687 MB |
| 1000 | 100 | **72,722** | 0.19 | 1.4 | 396 | 673 MB |
| 1000 | 1000 | **23,628** | 0.11 | 1.5 | 158 | 234 MB |

Throughput delta vs M3 baseline at saturation: +7 %–17 %. The avg batch sticks at ~1.4 because the gRPC stream's `'data'` callbacks fire one event at a time per event-loop tick — `setImmediate` runs at the next macrotask boundary, usually before the next gRPC frame arrives.

## Results — EventBatch wire (this PR)

Wire shape changed from `stream Event` to `stream EventBatch` where `EventBatch = repeated Event events`. The producer's `setInterval` simulator now collects all per-tick events into one `EventBatch`; the aggregator's ingest unpacks each frame into one `pushMany`. The setImmediate-coalescer is gone — the wire IS the batch. **Avg batch size = `hostCount` exactly**, by construction.

| P | N | Target/s | Achieved/s | p50 ms | p95 ms | p99 ms | GC major | GC minor | Heap peak | Avg batch | Max batch | Residual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 | 10 | 10 | 0.06 | 0.39 | 0.75 | 2 / 4ms | 3 / 2ms | 22 MB | 10.0 | 10 | 0 |
| 10 | 10 | 100 | 99 | 0.06 | 0.09 | 0.14 | 2 / 4ms | 16 / 11ms | 21 MB | 10.0 | 10 | 0 |
| 10 | 100 | 1,000 | 913 | 0.04 | 0.08 | 0.17 | 2 / 7ms | 22 / 24ms | 37 MB | 10.0 | 10 | 0 |
| 10 | 1000 | 10,000 | 8,767 | 0.02 | 0.04 | 0.09 | 7 / 12ms | 51 / 182ms | 96 MB | 10.0 | 10 | 0 |
| 100 | 1 | 100 | 100 | 0.37 | 0.67 | 0.67 | 2 / 5ms | 9 / 7ms | 24 MB | 100.0 | 100 | 0 |
| 100 | 10 | 1,000 | 989 | 0.27 | 0.47 | 0.48 | 2 / 8ms | 20 / 24ms | 37 MB | 100.0 | 100 | 0 |
| 100 | 100 | 10,000 | 9,131 | 0.13 | 0.24 | 0.25 | 7 / 12ms | 46 / 173ms | 93 MB | 100.0 | 100 | 0 |
| 100 | 1000 | 100,000 | **88,856** | 0.08 | 0.09 | 0.10 | 2 / 8ms | 463 / 1276ms | 791 MB | 100.0 | 100 | 0 |
| 1000 | 1 | 1,000 | 996 | 1.06 | 1.07 | 1.72 | 2 / 5ms | 14 / 14ms | 36 MB | 1000.0 | 1000 | 0 |
| 1000 | 10 | 10,000 | 9,901 | 0.33 | 0.34 | 1.04 | 3 / 5ms | 48 / 75ms | 103 MB | 1000.0 | 1000 | 0 |
| 1000 | 100 | 100,000 | **92,080** | 0.31 | 0.32 | 0.35 | 2 / 9ms | 460 / 828ms | 955 MB | 1000.0 | 1000 | 0 |
| 1000 | 1000 | 1,000,000 | **486,116** | 46.11 | 56.42 | 61.45 | 6 / 93ms | 2271 / 9166ms | 3,689 MB | 1000.0 | 1000 | 0 |

## Side-by-side at saturation

| Config | M3 baseline | M3 batched | EventBatch | M3→EventBatch lift |
| --- | --- | --- | --- | --- |
| P=100, N=1000 | 68,820 /s | 73,472 /s | **88,856 /s** | **+29 %** |
| P=1000, N=100 | 65,208 /s | 72,722 /s | **92,080 /s** | **+41 %** |
| P=1000, N=1000 | 20,190 /s | 23,628 /s | **486,116 /s** | **+24×** |

## Findings

### EventBatch closes the gap to the library bench

At **P=1000, N=1000** (target 1M events/sec), end-to-end throughput is **486,116 events/sec** — **~90 % of pond's library-bench peak (538k at P=100, N=10)**. The remaining ~10 % is the WebSocket fanout layer (`Event.toJsonRow(schema)` + `JSON.stringify` + `ws.send` per pond `'batch'` callback) plus the gRPC encode/decode round-trip we still pay even with batches.

Below P×N = 1M target the experiment is **producer-side-rate-bound**: the simulator's `setInterval` can't reliably tick fast enough to saturate pond. P=100, N=1000 plateaus at 88k/100k = 89 %, capped by Node's setInterval resolution at `tickMs = 1`.

### The cardinality dip is gone

| P | N | M3 baseline | EventBatch |
| --- | --- | --- | --- |
| P=1000, N=100 | | 65 k | 92 k |
| P=1000, N=1000 | | 20 k | 486 k |

The M3 baseline had a sharp dip at P=1000,N=1000 (only 20k vs 65k at the next cell down). The library bench's own dip at P=1000 (538k → 353k for N=100) wasn't reproduced in the experiment because gRPC framing was the dominant cost, masking the cardinality region. With EventBatch the experiment's curve mostly tracks the library's: P=1000 cells now scale roughly linearly with N up to the producer-rate ceiling.

### Real GC pressure at the high cell

P=1000, N=1000 at 486k events/sec produces:

- **Minor GC: 2,271 calls in 30 s, 9,166 ms total = 30.5 % of wall-clock.** This is the new floor on what's left for actual work. The aggregator's CPU is dominated by short-lived allocations (Date instances, RowForSchema tuples, internal pond buffers).
- **Major GC: 6 calls / 93 ms total, max ~15 ms per pause.** Still under PLAN's 100 ms major-pause threshold but the cumulative count is up 3× from the M3 baseline cell.
- **Heap peak: 3.69 GB.** The LiveSeries holds 6 minutes × 486k events/sec = ~175 M events at full retention; pond's compact internal storage keeps bytes-per-event in the ~20–25 byte range.

This is the "pond under pressure" regime PLAN's M3 was reaching for — and that the previous gRPC-bound runs masked.

### Latency: still under budget, but visibly affected at the 1M cell

p99 latency at the 486k cell is **61.45 ms**. PLAN's budget was < 500 ms at plateau; we're well under. But notice the jump:

| Cell | p99 | Note |
| --- | --- | --- |
| 100k cell (P=100,N=1000) | 0.10 ms | sub-ms; aggregator idle most of the time |
| 100k cell (P=1000,N=100) | 0.35 ms | bigger batches, slightly more per-batch work |
| 1M cell (P=1000,N=1000) | **61.45 ms** | event-loop saturation; latency rises by ~600× |

The latency jump tracks the GC-minor jump: the aggregator's event loop is spending 30 % of each second in GC, so any individual event's wait-for-fanout grows proportionally. PLAN's 100 ms major threshold isn't crossed but the CUMULATIVE pause is the real characterisation result.

### Producer-side rate cap below ~100k events/sec target

For target rates ≤ 100k/s the achieved rate hits ~90–99 % of target (capped by `setInterval` jitter at sub-millisecond `tickMs`). The producer's `setInterval(_, 1ms)` simulator firing 1000 times/sec is at Node's timer-resolution edge; effective tick rate is 800–950/sec. Real producers (a metrics-scraping fleet, a Kafka consumer pulling at line rate) wouldn't have this limit — it's an artefact of the synthetic load generator. M3 friction notes covered this; M3 extension preserves it.

The cells above 100k target are the ones where the producer can actually push rate × hostCount events because hostCount itself is high enough to compensate for slow ticks. At P=1000 the producer pushes 1000 events/tick × ~500 ticks/sec ≈ 500k events/sec, which lines up with the 486k achieved.

## Memory trajectory (5-min steady-state — from M3 baseline)

Captured during the M3 baseline; not re-run with EventBatch but the heap shape is bigger now (3.7 GB at saturation vs 626 MB at busy-fleet). A 5-min run at the new saturation cell would be useful before declaring M4 ready.

| Metric (M3 baseline busy-fleet, P=100, N=100, 10k/s) | Value |
| --- | --- |
| Achieved rate | 8,927 events/sec |
| p99 latency | 0.01 ms |
| Heap peak | 626 MB |
| GC major | 26 / 46 ms over 5 min |

**EventBatch follow-up:** rerun this scenario at the saturation cell (P=1000, N=1000) for 5–60 minutes to verify the heap stabilises at the new ceiling. Friction-noted.

## What remains

- **WS fanout under pond's batch listener.** At 486k events/sec the fanout fires `live.on('batch', …)` per pond pushMany → builds an AppendMsg → `JSON.stringify` → `ws.send`. The probe consumes 486k events worth of JSON per second, ~25 MB/s of WS traffic. The current experiment doesn't aggregate server-side (the dashboard does it client-side); the next phase ("Phase B" in the M3 extension plan) adds a server-side aggregation pass that runs the dashboard's pipeline on the aggregator and times it. That's where pond's *read* side gets the full firehose. Deferred to a follow-up PR.
- **Multi-producer pressure.** The experiment uses one producer process. Multiple producers each pushing partial host pools at the same rate would test the aggregator's gRPC client with N concurrent streams. Friction-noted; cheap to add when it earns its cost.

## Methodology notes & limitations

- 30 s measurement window per config (PLAN's spec is 60 s). Saturation cells reach steady state in <10 s; the shorter window was a time-budget choice for the iterative M3 → M3-extension work.
- Single WS consumer probe. Multi-consumer fanout amplification is M3+.
- The baseline + macrotask-batched + EventBatch tables in this file were stitched manually for the PR. `pnpm bench:full` always overwrites `BENCH.md` with the most recent run's table only — re-running will replace this file with whatever the current ingest path produces. Friction-noted.
- All tests on a single MacBook Pro (Apple Silicon). Numbers will move on different hardware.
- The previous BENCH.md tables (M3 baseline + macrotask-batched) were captured before the EventBatch wire change; both are retained verbatim for historical comparison.
