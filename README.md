# pond-grpc-experiment

Three-tier real-ish stack used to stress-test [`pond-ts`](https://github.com/pjm17971/pond-ts) and surface API friction. Synthetic per-host CPU/request events flow gRPC → aggregator (pond pipelines) → React dashboard over WebSocket.

```
┌──────────────┐      gRPC          ┌────────────────┐    WebSocket    ┌─────────────┐
│   producer   │ ─────────────────▶ │   aggregator   │ ──────────────▶ │     web     │
│              │  events stream     │                │   /live         │             │
│  synthetic   │                    │  pond LiveSer- │   /live-agg     │  React +    │
│  CPU/req     │                    │  ies + rolling │                 │  Recharts   │
│  generator   │                    │  aggregations  │   /metrics      │             │
└──────────────┘                    └────────────────┘    (Prometheus) └─────────────┘
   :50051                              :8080                              :5173
```

The dashboard pedagogy lives in [`packages/web/README.md`](./packages/web/README.md). This README covers **operational** questions: how to run each tier by hand, what knobs they accept, where to peek at what's flowing.

---

## Prerequisites

- **Node 22+** — the project pins `engines.node >=22` and the dev environment defaults to `nvm use 22`. v18/v20 will fail at startup with TLA / `import.meta` errors.
- **pnpm 8.10.2** — workspace tooling. `corepack enable` picks it up.
- **`protoc`** — needed once for codegen. Install via `brew install protobuf` (macOS), `apt install protobuf-compiler` (Debian), or [the protoc binaries page](https://github.com/protocolbuffers/protobuf/releases). Only required when the `.proto` schema changes; the generated TypeScript is regenerated from `packages/shared/proto/events.proto`.

---

## First-time bootstrap

```bash
nvm use 22
pnpm install
pnpm codegen          # generates packages/shared/src/grpc/events.ts (git-ignored)
pnpm -r run typecheck # confirms nothing's stale
```

If you skip `pnpm codegen` on a fresh checkout, the producer and aggregator both fail at startup with `Cannot find module '@pond-experiment/shared/src/grpc/events.ts'`.

---

## All three tiers in one shot

```bash
pnpm dev
```

Runs producer + aggregator + web in parallel via `pnpm -r --parallel --stream`. Output is interleaved with package prefixes; Ctrl-C tears all three down. Open `http://localhost:5173/` to see the dashboard.

For everything below, the convention is: **commands run from the repo root unless noted.**

---

## Tier 1 — producer

A gRPC server that emits a synthetic stream of `(time, cpu, requests, host)` events at a fixed rate. Lives in `packages/producer`.

```bash
pnpm dev:producer
# or, with explicit knobs:
GRPC_PORT=50051 EVENTS_PER_SEC=10 HOST_COUNT=4 VARIABILITY=0.4 \
  pnpm --filter @pond-experiment/producer dev
```

Env vars (all optional):

| Var               | Default | Notes                                                     |
| ----------------- | ------- | --------------------------------------------------------- |
| `GRPC_PORT`       | `50051` | Port for the gRPC server.                                 |
| `EVENTS_PER_SEC`  | `2`     | Total event rate across all hosts.                        |
| `HOST_COUNT`      | `4`     | Number of synthetic hosts (`api-1`…`api-N`).              |
| `VARIABILITY`     | `0.4`   | Scale factor on the noise injected into the cpu signal.   |

Readiness line on stdout: `producer listening on :50051 (events=2/s, hosts=4, variability=±0.4)`. The producer is stateless — kill and restart freely.

---

## Tier 2 — aggregator

A Fastify HTTP/WS server that subscribes to the producer over gRPC, pushes events into a pond `LiveSeries`, runs partitioned rolling aggregations, and exposes three endpoints. Lives in `packages/aggregator`.

```bash
pnpm dev:aggregator
# or:
AGGREGATOR_PORT=8080 PRODUCER_URL=127.0.0.1:50051 \
  pnpm --filter @pond-experiment/aggregator dev
```

Env vars:

| Var                | Default              | Notes                                                  |
| ------------------ | -------------------- | ------------------------------------------------------ |
| `AGGREGATOR_PORT`  | `8080`               | HTTP/WS port.                                          |
| `PRODUCER_URL`     | `127.0.0.1:50051`    | Where to find the producer's gRPC server.              |

Endpoints:

| Path        | Protocol  | What flows                                                                                                        |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `/live`     | WebSocket | Raw event firehose. One `snapshot` on connect, then `append` frames per gRPC batch.                               |
| `/live-agg` | WebSocket | Per-host tick aggregates (200 ms cadence) — `cpu_avg`, `cpu_sd`, `cpu_n`, `n_current`, anomaly arrays. See WIRE.md. |
| `/metrics`  | HTTP      | Prometheus exposition — ingest rate, fanout pressure, e2e latency histograms.                                     |

Readiness line: `aggregator listening on :8080 (producer=127.0.0.1:50051)`. The aggregator subscribes lazily — no producer means no frames go out, but the WS endpoints accept connections regardless.

---

## Tier 3 — web

Vite-served React dashboard. Lives in `packages/web`.

```bash
pnpm dev:web
# or, pointing at a non-default aggregator:
VITE_WS_URL=ws://localhost:9000/live pnpm dev:web
```

Env vars (all `VITE_`-prefixed so Vite exposes them to the bundle):

| Var                | Default                       | Notes                                                                                                          |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `VITE_WS_URL`      | `ws://localhost:8080/live`    | Raw firehose. The aggregate URL is derived from this by swapping `/live` → `/live-agg` unless overridden.        |
| `VITE_WS_AGG_URL`  | (derived from `VITE_WS_URL`)  | Explicit override for the aggregate endpoint when it lives on a different host/port.                            |

The dev server listens on Vite's default `:5173`. `pnpm build:web` produces a static bundle in `packages/web/dist/`.

---

## Talking to the wire by hand

Useful when you want to confirm what the aggregator is shipping without spinning up the dashboard.

**Raw firehose:**

```bash
npx wscat -c ws://localhost:8080/live | head -2
# {"type":"snapshot","rows":[]}
# {"type":"append","rows":[[1729..., 0.51, 100, "api-1"]]}
```

**Aggregate stream:**

```bash
npx wscat -c ws://localhost:8080/live-agg | head -2
# {"type":"aggregate-snapshot","thresholds":[1,1.5,2,2.5,3],"rows":[]}
# {"type":"aggregate-append","rows":[{"ts":172..., "host":"api-1", "cpu_avg":..., ...}]}
```

**Metrics:**

```bash
curl -s http://localhost:8080/metrics | grep aggregator_ | head
```

---

## Common scenarios

**"I want to see the dashboard with traffic."**
`pnpm dev`. Default config — 2 events/sec across 4 hosts — is calm enough to see the bands form.

**"I want load."** Bump the producer:
```bash
EVENTS_PER_SEC=10000 HOST_COUNT=100 pnpm dev:producer &
pnpm dev:aggregator &
pnpm dev:web
```
The dashboard's CPU bands tighten and the anomaly arrays start carrying non-zero counts.

**"I want to bench the aggregator without the dashboard."**
```bash
pnpm bench:agg --P=100 --N=1000 --seconds=30
```
Spawns a producer, an aggregator, a probe; reports raw-rows/sec, tick fps, e2e latency, heap/GC. `--P` is host count, `--N` is per-host events/sec.

**"I want the canonical perf suite."**
```bash
pnpm perf
```
Four bench points (9k/s, 87k/s, 92k×1k, ceiling-regime 1M target) plus a 20-second cpu-profile run. ~3:30 wall-clock. Profiles land in `/tmp/agg-prof/`.

**"I want to profile the aggregator at a specific load."**
```bash
pnpm --filter @pond-experiment/aggregator exec tsx scripts/profile-agg.ts \
  --P=1000 --N=1000 --seconds=20 --profDir=/tmp/agg-prof
node packages/aggregator/scripts/analyze-cpuprofile.mjs \
  /tmp/agg-prof/<largest-cpuprofile>
```
The largest of the three profile files is the aggregator main thread.

---

## Tests, typecheck, lint

```bash
pnpm check         # typecheck + tests across all packages
pnpm test          # tests only
pnpm test:e2e      # Playwright end-to-end (web ↔ aggregator ↔ producer)
pnpm -r typecheck  # typecheck only
```

The `e2e` package isn't included in `pnpm test` (it spawns real processes and is slow); run it explicitly via `pnpm test:e2e`.

---

## Pointers

- **[`packages/web/README.md`](./packages/web/README.md)** — the dashboard's pond patterns, written for someone learning `@pond-ts/react`.
- **[`WIRE.md`](./WIRE.md)** — `/live-agg` wire format and the dashboard's rendering contract.
- **[`friction-notes/`](./friction-notes/)** — accumulated API-friction observations, one file per milestone. M5's extraction sweep produces three RFCs from these.
- **[`friction-notes/rfcs/`](./friction-notes/rfcs/)** — concrete library proposals derived from the friction notes. Currently: fused multi-window rolling.
- **[`packages/aggregator/BENCH.md`](./packages/aggregator/BENCH.md)** — canonical throughput numbers; regenerated by `pnpm bench:full`.
- **[`packages/aggregator/scripts/profile-analysis-v6-vs-v7.md`](./packages/aggregator/scripts/profile-analysis-v6-vs-v7.md)** — most recent perf delta writeup.
- **[`PLAN.md`](./PLAN.md)** — milestone breakdown (M0–M5).
