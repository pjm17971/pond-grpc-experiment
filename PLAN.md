# Build plan: gRPC → aggregator → dashboard

A staged plan for the three-tier experiment. The thesis: pond-ts as a single library running on producer, aggregator, and browser, with a shared schema, append-only wire protocol, and symmetric `LiveSeries` instances on both ends of the WebSocket.

The experiment validates the *shape* of the stack — same library top to bottom, snapshot+append protocol, single-thread aggregator — and doubles as a forcing function for the four packages that should make this pipeline a frictionless recipe.

## Goals

In rough priority:

1. **Validate the symmetric `LiveSeries` model end-to-end.** Aggregator runs one; client runs one; events flow between them. Same library, same schema, same operations available on both ends.
2. **Reduce pipeline friction.** Treat every line of glue code we write as an "should this be a library?" candidate. The experiment exists in part to discover the right API surface for `@pond-ts/server`, `useRemoteLiveSeries` in `@pond-ts/react`, and a future `@pond-ts/dev-producer`.
3. **Characterise the single-thread aggregator's operating envelope.** What ingest rate, partition count, and client count can one Node process handle before something cracks? Where does it crack?
4. **Surface the operational concerns toy demos hide.** Reconnect, backpressure, slow clients, schema evolution, GC. Each gets at least one experiment.
5. **Prove or falsify the "no threading needed" claim.** The library benchmark suggests single-thread covers realistic load. The experiment puts that under stress with real I/O on both ends.

Non-goals:
- Production-grade observability features (alerting, persistence, RBAC, multi-tenancy).
- A polished UI redesign — the existing dashboard is the read-side.
- Solving multi-aggregator federation. Note the shape; don't build it.
- Publishing the extracted packages during the experiment. The goal is to *discover* their API surfaces; publishing follows.

## The eventual stack we're scoping toward

The experiment validates this composition. Each tier eventually becomes a published package:

```
producer(s)              aggregator                 React app             charts
@pond-ts/dev-producer    pond-ts                    @pond-ts/react        @pond-ts/charts
                         + @pond-ts/server          (incl. useRemote-     (existing
                                                     LiveSeries)           direction)
```

- **`@pond-ts/dev-producer`** — Schema-aware synthetic gRPC source. Hand it your `as const` schema and a few knobs (rate, partitions, anomaly rate, gap simulation), it streams events. Like `stripe listen` for live time-series. Lets a new user develop their dashboard before any real source exists.
- **`@pond-ts/server`** — The aggregator pattern as a library. Wraps a `LiveSeries` with the WS protocol, snapshot-on-connect, slow-client policy, snapshot caching. Target API: `liveSeriesServer(live, { port, slowClient, snapshotCache })`. The biggest single friction-removal opportunity in the stack.
- **`@pond-ts/react` + `useRemoteLiveSeries(url)`** — Symmetric to `useLiveSeries(opts)` but with the WS protocol baked in. Components shouldn't be able to tell whether the source is local or network.
- **`@pond-ts/charts`** — Eventual landing place for the gap-aware, scatter-overlay, animation-off-by-default conventions we hand-rolled in the dashboard.

A successful experiment delivers working code that, with one extraction sweep, becomes the first three of these packages.

## Architecture (target state)

```
producer (Node)              aggregator (Node)              browser (React)
  ├─ generates events    →    ├─ subscribes to gRPC    →    ├─ WS subscribes
  ├─ gRPC server (TLS?)       ├─ LiveSeries{retention}      ├─ LiveSeries{retention}
  └─ configurable             ├─ on('batch', ...)           ├─ ingests snapshot
     rate, partitions         ├─ ws.send per batch            + appends deltas
                              └─ snapshot-on-connect        └─ pond-ts derivations
                                                               render dashboard

shared/
  └─ schema.ts (the as const schema, imported by all three tiers)
```

All three tiers import the same `schema` const. Schema changes are TypeScript-breaking changes for everyone, by design.

## Tech choices

- **Language**: TypeScript everywhere. Node 22+ on producer/aggregator.
- **gRPC**: `@grpc/grpc-js` + `ts-proto`. Server-streaming RPC: producer→aggregator pushes events.
- **WebSocket**: `ws` (Node) + browser WebSocket. Plain JSON frames for v1; revisit MessagePack/protobuf only if measurement says wire is the bottleneck.
- **Build**: pnpm workspaces. One repo, three deployable packages, one shared package.
- **Test runner**: vitest in each package.

## Repo layout

```
pond-grpc-experiment/
  package.json              (pnpm workspace root)
  pnpm-workspace.yaml
  packages/
    shared/                 (schema, wire types, proto)
      src/
        schema.ts
        wire.ts             (snapshot/append envelopes)
      proto/
        events.proto
    producer/               (Node, gRPC server)
      src/
        index.ts
        simulator.ts
        grpc.ts
    aggregator/             (Node, gRPC client + WS server)
      src/
        index.ts
        ingest.ts           (gRPC client → LiveSeries.push)
        fanout.ts           (LiveSeries → WS clients)
        snapshot.ts         (toJSON cache for reconnects)
    web/                    (existing pond-web, repurposed)
      src/
        useRemoteLiveSeries.ts  (replaces useSimulator)
        ...                 (rest of dashboard unchanged)
```

The existing `pjm17971/pond-ts-dashboard` repo becomes `packages/web`. Other packages are new.

---

## Milestones

Each milestone is independently mergeable. Plan to spend roughly the time noted; if it spills past 2× that, regroup.

For each milestone, "Friction notes" capture the data inputs to the eventual extraction sweep (M5). Treat them as serious deliverables, not bookkeeping.

### M0 — Monorepo + shared schema (~1 day)

The smallest commit that gets you to "everyone imports the schema from one place."

**Deliverables:**
- pnpm workspace skeleton with `packages/shared`, `packages/aggregator`, `packages/web`.
- `packages/shared/src/schema.ts` exports the `as const` schema.
- `packages/web` migrated into the workspace, references `@pond-experiment/shared` for the schema.
- CI runs `tsc --noEmit` across all packages.

**Exit criteria:**
- `tsc -b` clean across the whole workspace.
- Web dashboard runs as before (no behaviour change yet — still uses local simulator).
- Schema is imported from `@pond-experiment/shared` in `useDashboardData.ts`.

**Friction notes:** None expected. This is plumbing.

### M1 — WebSocket bridge with internal simulator (~3–5 days)

The symmetric-LiveSeries protocol working end-to-end with the simulator inside the aggregator. No gRPC yet — wire it in M2.

**Deliverables:**
- `packages/aggregator/src/index.ts`: HTTP + WS server (`fastify` + `ws`).
- `packages/aggregator/src/ingest.ts`: internal simulator (lifted from `packages/web/src/useSimulator.ts`) pushing into a server-side `LiveSeries`.
- `packages/aggregator/src/fanout.ts`: subscribes to the LiveSeries via `on('batch')`, sends each batch as `{ type: 'append', rows: [...] }` to every connected client.
- `packages/aggregator/src/snapshot.ts`: on new connection, emits `{ type: 'snapshot', rows: live.toJSON().rows }` first, then forwards future batches.
- `packages/web/src/useRemoteLiveSeries.ts`: new hook that mounts a client-side `LiveSeries`, opens a WS, ingests snapshot via bulk `push()`, appends future deltas via `push()`.
- `packages/web/src/Dashboard.tsx`: swap `useSimulator(...)` for `useRemoteLiveSeries(WS_URL)`. Everything else unchanged.

**Exit criteria:**
- Dashboard at `localhost:5173` renders identically to current behaviour, but data is now flowing through `localhost:WS_PORT`.
- Two browser tabs connected simultaneously see the same data, both in step.
- Disconnect a tab; reconnect; chart resumes.
- Schema changes (e.g., add a `region` column) require an edit in `packages/shared` and break compilation of all three packages until each handles the new column. Demonstrate this once and check it in.

**Friction notes — what to capture:**
- LOC of the WS bridge in `aggregator/src/fanout.ts` + `snapshot.ts`. **This is the future `@pond-ts/server`.** If it's <150 LOC of generic code, the package is one file.
- LOC of `useRemoteLiveSeries.ts`. **This is the future `useRemoteLiveSeries` in `@pond-ts/react`.**
- API decisions where the choice was non-obvious — these are the docs the eventual packages need to write up front.
- Anything we wished was already in the library (e.g. did we need `LiveSeries.toJSON()` to behave a particular way? did `on('batch')` give us what we needed?).

**What this proves:**
- The symmetric model works.
- The bridge is small enough to be a library, not a per-project rewrite.
- Schema-as-protocol is real, not aspirational.

### M2 — Replace internal simulator with gRPC producer (~3–5 days)

Producer becomes its own process. Aggregator becomes a pure relay.

**Deliverables:**
- `packages/shared/proto/events.proto`: server-streaming RPC `Subscribe(SubscribeRequest) returns (stream Event)`.
- `packages/producer/src/grpc.ts`: gRPC server implementing `Subscribe`.
- `packages/producer/src/simulator.ts`: lifted from M1, parameterizable rate / hostCount / variability via env vars or HTTP control endpoint.
- `packages/aggregator/src/ingest.ts`: reverts to gRPC client. On startup, dials the producer's `Subscribe` RPC; for each `Event`, pushes into the local LiveSeries. Reconnects with backoff if the producer drops.

**Exit criteria:**
- Three processes running: `producer`, `aggregator`, browser.
- `kill -9 producer` → aggregator shows clean error, attempts reconnection, recovers when producer restarts.
- `kill -9 aggregator` → browser sees connection close, attempts reconnection (with snapshot+append on resume).
- Schema is still the import-once-from-shared story, now generating proto types AND the pond schema from the same source of truth.

**Friction notes — what to capture:**
- The producer's structure: simulator + gRPC server. **This is the future `@pond-ts/dev-producer`.** What's project-specific (the simulator's domain) vs reusable (the gRPC framing, the schema-driven event shape)?
- The aggregator's gRPC ingest layer. Is this generic enough to be in `@pond-ts/server` as a built-in adapter, or is gRPC too domain-specific and we just provide examples?

**What this proves:**
- The gRPC layer is genuinely separable; producer and aggregator are decoupled processes.
- Schema-as-protocol survives a binary wire format (proto on one hop, JSON on the other).

### M3 — Throughput characterisation (~5–7 days)

The actual experiment. Push the system until something gives, document where.

**Deliverables:**
- Producer accepts `--rate` (events/sec/host) and `--hosts` (partition count) flags.
- Aggregator exports a metrics endpoint:
  - events/sec ingested from gRPC
  - LiveSeries length (current retention)
  - per-WS-client buffered amount
  - GC stats from `process.memoryUsage()` and `perf_hooks`
  - p50 / p95 / p99 ingest→fanout latency
- Bench script (`packages/aggregator/scripts/bench.ts`) sweeps hosts ∈ {10, 100, 1000} × rate ∈ {1, 10, 100, 1000} per host, runs each for 60s, captures the metrics.
- Results captured in a `BENCH.md` in the aggregator package.

**Exit criteria:**
- Plateau identified within 20% of the library benchmark (~350–540k events/sec single-thread).
- p99 ingest→fanout latency under 100ms at 50% of plateau, under 500ms at plateau.
- GC pauses characterised: are they sub-100ms majors (acceptable) or stop-the-world hundreds-of-ms (problem)?
- The P=1000 cardinality dip from the library bench reproduces; we know whether it's partition-spawn cost or steady-state lookup cost.
- Memory growth pattern over a 1-hour run is bounded.

**Friction notes — what to capture:**
- What metrics did we wish pond-ts exposed natively (rather than counting from the outside)?
- Did `LiveSeries.toJSON()` performance matter? If yes, this informs `@pond-ts/server`'s snapshot caching design.
- Did we have to do anything weird to keep GC happy? If yes, that's a library docstring.

**What this proves:**
- The single-thread budget is real and reproducible under WS+gRPC.
- The bottleneck under stress: pond, JSON.stringify, ws.send, or GC. We know which.

### M4 — Failure modes and operating envelope (~3–5 days)

Operational concerns toy demos hide.

**Deliverables:**
- Slow-client handling: if a WS client's `bufferedAmount` exceeds 5MB for 10s, close the connection. Document the policy.
- Reconnect storm test: kill aggregator, restart, have 50 clients reconnect simultaneously. Each gets a snapshot. Measure aggregate snapshot egress; introduce a snapshot cache (refresh every 1s) if it spikes.
- Schema migration test: add a column, verify all-three-tiers compile-break, exercise the upgrade path.
- Backpressure test: producer at 200% of aggregator's WS egress capacity. Aggregator's LiveSeries shouldn't grow without bound; one of (drop, sample, error) needs to be the answer. Pick one, document it.

**Exit criteria:**
- An ops runbook one-pager in `packages/aggregator/OPERATING.md` covering: slow-client policy, reconnect behaviour, schema migration, backpressure response.
- Each policy is exercised by a script in `scripts/` that injects the failure and verifies the response.

**Friction notes — what to capture:**
- Each policy decision (e.g., "close at 5MB buffered for 10s") is a *default*. The eventual `@pond-ts/server` API should expose these as options. Capture the chosen defaults *and* the thinking behind each.
- The snapshot cache pattern: did we need it? At what rate did we need to refresh? **Direct input to `@pond-ts/server`'s snapshot-cache design.**
- The schema migration ergonomics — was adding a column actually painless? If not, where was the friction?

**What this proves:**
- The system has documented, predictable failure behaviour.
- The defaults that should ship with `@pond-ts/server`.

### M5 — Extraction sweep (~3–5 days)

The post-experiment review. Walk the working code with the question "what here belongs in a library, and what's the API surface?"

**Deliverables:** three RFC-style design docs, one per package candidate. Each captures:
- API surface (TypeScript signatures, configuration shape, default values)
- Behaviour notes (what it does, what it doesn't do, what the user is responsible for)
- Open questions and tradeoffs left for the eventual real implementation
- A "lift-and-shift" estimate: how much of the experiment's code is the package; how much is project-specific glue

**The three RFCs:**

1. **`@pond-ts/server` design.** Based on `packages/aggregator/src/{fanout,snapshot}.ts` plus the slow-client and reconnect policies from M4. Target API:
   ```ts
   import { liveSeriesServer } from '@pond-ts/server';
   const server = liveSeriesServer(live, {
     port: 8080,
     slowClient: { closeAfterMs: 10_000, maxBufferedBytes: 5_000_000 },
     snapshotCache: { ttlMs: 1_000 },
   });
   ```
2. **`useRemoteLiveSeries` design** (incoming addition to `@pond-ts/react`). Based on `packages/web/src/useRemoteLiveSeries.ts`. Target API:
   ```ts
   const [live, snap] = useRemoteLiveSeries(WS_URL, { schema, retention });
   // identical downstream surface to useLiveSeries
   ```
3. **`@pond-ts/dev-producer` design.** Based on `packages/producer/`. Target API: a CLI that takes a schema file and rate/partitions/anomaly knobs, runs a gRPC server emitting matching events. Like `stripe listen` for time-series.

**Exit criteria:**
- Three RFC documents in the experiment repo's `docs/` folder.
- Each RFC has been reviewed by both the dashboard maintainer and the library maintainer (you and the agent).
- The RFCs identify which experiment files lift cleanly, which need rewriting, and which are project-specific noise.

**What this proves:**
- The extracted packages are real and shippable, not speculative.
- The API surfaces are informed by working code, not whiteboard guesses.

### M6 (optional) — Production-ish concerns

Skip unless something in M3/M4/M5 specifically motivates it.

- TLS for both gRPC and WS hops.
- AuthN/AuthZ on the WS — token in the connect URL, validated server-side.
- Multi-aggregator routing.
- Snapshot persistence — on aggregator restart, recover the last snapshot from disk so reconnecting clients get continuity.

These are real production concerns. None are needed to validate the architecture or scope the libraries.

---

## Cross-cutting concerns

### Testing strategy

Per-package vitest. Two integration test patterns:

- **In-process tests**: aggregator uses a fake gRPC source; web tests use a fake WS server. Keeps unit tests fast.
- **Three-process tests**: spawn all three, run for N seconds, assert end-to-end. Gate behind `npm run test:e2e`.

### Observability of the experiment itself

The aggregator's `/metrics` endpoint is non-negotiable. Without numbers, M3 is impossible. JSON is fine; Prometheus format if scraping with Grafana.

### Deployment for demos

For a public demo:
- Producer: Fly.io machine (small, always-on)
- Aggregator: Fly.io machine (medium; this is where compute happens)
- Web: GitHub Pages (already at `https://pjm17971.github.io/pond-ts-dashboard/`)

WebSocket from Pages to a Fly.io domain just works. CORS handled at the aggregator. TLS termination at Fly's edge.

---

## Open questions / risks

In rough order of "this might bite us":

1. **Browser WebSocket reconnect during snapshot transfer.** A 540MB toJSON over a 5MB/s WS is 100+ seconds. Mitigations: smaller default retention, snapshot the *intersection* of pre-existing data and the client's last-seen-ts, or accept a one-time "loading…" UI. Informs `@pond-ts/server`'s snapshot strategy.

2. **`LiveSeries.toJSON()` cost at scale.** Don't know yet whether toJSON is fast or whether it competes with the event-arrival rate. M3 should measure this explicitly. **Direct input to `@pond-ts/server`'s snapshot caching design.**

3. **Per-client filtering vs broadcast.** If 50 clients each want a different host subset, the aggregator either filters per-connection (50× CPU) or broadcasts everything and lets clients filter (50× egress). Default to the latter for the experiment; note the cost. Informs whether `@pond-ts/server` should support server-side filtering.

4. **Schema evolution mid-flight.** "Producer ships old schema while client runs new schema" is the realistic upgrade case. M4 needs to actually exercise this.

5. **GC pauses on the aggregator.** 540MB heap with frequent allocations is in the territory where major GCs can be hundreds of ms. Mitigations: smaller per-event allocation, tuned `--max-old-space-size`, or accept and measure.

6. **gRPC stream backpressure.** `@grpc/grpc-js` has internal buffering; if the producer is faster than the aggregator, backpressure should propagate. If it doesn't, M3 will surface this as unbounded memory growth.

---

## What success looks like

End of M3, you can:
- Stand up the three processes locally with one command (`pnpm dev` at the root).
- Open the dashboard, see live data flowing, all of which originated from the gRPC producer.
- Run the bench script and produce a markdown table of throughput vs cell that matches or beats the library bench under realistic I/O.
- Open another browser tab and see the same data, in sync.
- Kill any process, watch the others detect, recover when restarted.

End of M4, you can additionally:
- Hand someone the `OPERATING.md` and they understand what happens when each failure mode trips.
- Demonstrate a schema column add survives a deploy.
- Show that a slow client doesn't bring down a fast one.

End of M5 (the extraction sweep), you have:
- Three RFC documents specifying `@pond-ts/server`, `useRemoteLiveSeries` for `@pond-ts/react`, and `@pond-ts/dev-producer`.
- A clear estimate of the lift to publish each.
- The dashboard at `pjm17971.github.io/pond-ts-dashboard` is the read-side of an actually-real system.

End of all of this, the message to a prospective pond-ts user is two-fold:

> **"Same TypeScript code on producer, aggregator, and dashboard, with characterised throughput, latency, and failure modes for the obvious topology."**

And the bigger pitch, once the extracted packages ship later:

> **"From event source to live React dashboard in one scaffold; everything in TypeScript; no glue code."**

```bash
$ npm create pond-ts-app my-dashboard
✓ Schema declared in shared/schema.ts
✓ Producer scaffolded (synthetic source, configurable rate)
✓ Aggregator scaffolded (gRPC ingest + WS server)
✓ React app scaffolded with example dashboard
✓ Three processes wired with one `pnpm dev`
```

That's the scaffold the four packages enable. The experiment is the working code that proves the scaffold isn't speculative — every line in it was written, measured, and refined under load.
