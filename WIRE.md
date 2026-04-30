# Aggregate wire schema for the dashboard

A spec for the server-side aggregation work in `pond-grpc-experiment`. Reading this cold, you should come away with: what the dashboard renders, what data it actually needs, what the wire shape should be, and where the σ-anomaly density model fits in. Pointers to relevant existing code at the bottom.

This was authored by the dashboard agent (Claude) after reviewing what the dashboard renders today against the planned move from a raw-event WebSocket stream to a server-aggregated stream. It is meant to inform the M3/M4 wire-schema decisions in the experiment, not bind them — adapt where measurement says otherwise.

## Context

Today the aggregator forwards every raw event over WebSocket. The client mounts a symmetric `LiveSeries` and runs the entire pond pipeline (`partitionBy('host').baseline('cpu', { window: '1m', sigma, minSamples: 30 }).toMap(...)`) on the receive side. That works at low rates (8 events/sec total in the demo), but doesn't survive the experiment's target firehose (~500k events/sec at the producer).

The plan is for the aggregator to do server-side aggregation per host on a fixed tick (every ~200ms per partition) and ship that aggregate stream to the browser. **The dashboard's UI shouldn't change** — the user still sees per-host bands, anomaly density, smoothed line, recent-events log — but the data underneath is now ~5 ticks/sec/host instead of every push.

Half a million events/sec → roughly 100 hosts × 5 ticks/sec = 500 frames/sec on the wire. **Three orders of magnitude reduction**, no UI regression if the wire schema is right.

## Design principle

**Render-time concerns stay on the client. Statistics-of-data concerns move to the server.**

The σ slider, EMA α, the 5-min window choice, the "show extremes" toggle — these are knobs the user turns hundreds of times a session. Round-tripping any of them via a control endpoint is wrong; they're presentation, not data.

The corollary: **the server emits statistics rich enough that the client can apply any σ, any α, any window locally, without re-querying.** This is the constraint that drives the wire schema below.

## Wire schema

### Per host, every tick

```ts
type HostTick = {
  ts: number;                      // tick timestamp, aligned across all hosts
  host: string;

  // Band-rendering statistics — enough for the client to draw bands at any σ
  cpu_avg: number | null;          // null when cpu_n === 0
  cpu_sd: number | null;
  cpu_n: number;                   // sample count this tick

  // Anomaly density — count of samples >Nσ above/below the rolling mean,
  // at fixed thresholds. See "anomaly density" section below.
  anomalies_above: number[];       // length matches threshold array (e.g. [1, 1.5, 2, 2.5, 3])
  anomalies_below: number[];

  // Request statistics
  requests_avg: number | null;
  requests_sum: number;
  requests_n: number;
};
```

`cpu_n` and `requests_n` are the per-tick sample counts. They serve double duty: the client gates render on `sum(cpu_n over last 1m) >= 30` (the equivalent of the existing `minSamples` mask), and they let the client compute *rates* if it wants ("3% of samples this tick were anomalous").

When a host had zero samples in a tick (the partition went silent), either omit the host's frame entirely or emit one with `cpu_n = 0` and `null` statistics. Client treats `null` avg/sd the same way it treats today's masked `undefined` — a gap in the line, no band that tick.

### Per tick, global (not per-host)

```ts
type GlobalTick = {
  ts: number;
  events_ingested_total: number;   // running cumulative since aggregator start
  events_per_sec: number;          // ingest-side rate at the gRPC hop
  evicted_total: number;
};
```

Drives the page-summary stats (Total events, Event rate, Evicted) that today are computed client-side from the raw stream. Cheaper to ship one number per tick than to have the client re-derive from the aggregate.

### Snapshot frame on connect

Same shape as today's `snapshot` envelope, but the rows are `HostTick` aggregates (the most recent N ticks across all hosts) plus a globals history. The client mounts its `LiveSeries` keyed on the same `HostTick` schema, ingests the snapshot, then appends future ticks. Symmetric model preserved.

The client's `LiveSeries` schema becomes:

```ts
const aggregateSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu_avg', kind: 'number' },
  { name: 'cpu_sd', kind: 'number' },
  { name: 'cpu_n', kind: 'number' },
  // anomaly count columns can be array-kind (post-0.5.0 pond-ts):
  { name: 'anomalies_above', kind: 'array' },
  { name: 'anomalies_below', kind: 'array' },
  { name: 'requests_avg', kind: 'number' },
  { name: 'requests_sum', kind: 'number' },
  { name: 'requests_n', kind: 'number' },
] as const;
```

### Threshold list

Server emits a one-time configuration on the snapshot frame:

```ts
type Snapshot = {
  type: 'snapshot';
  thresholds: number[];            // e.g., [1, 1.5, 2, 2.5, 3]
  rows: HostTick[];
  globals: GlobalTick[];
};
```

Default `[1, 1.5, 2, 2.5, 3]`. Different deployments may want different thresholds — high-volume telemetry might use `[2, 3, 4, 5, 6]` so every tick doesn't light up. Treat as deploy-time server config, not per-frame.

## Anomaly density (the σ-thresholded counts approach)

This replaces the existing per-event anomaly dots and the existing per-event red-dot scatter overlay.

### What server computes

For each host, every tick, count samples whose deviation from the tick's rolling mean exceeds each σ threshold. Above and below kept separate so the dashboard can render asymmetric outliers (CPU spikes vs collapses are operationally different).

Example tick output for one host:

```ts
{
  cpu_avg: 0.55,
  cpu_sd: 0.08,
  cpu_n: 1000,
  anomalies_above: [876, 62, 12, 1, 0],   // > 1, 1.5, 2, 2.5, 3 σ above
  anomalies_below: [543, 41, 8, 0, 0],
}
```

Reads as "of 1000 samples this tick, 876 were >1σ high, 543 were >1σ low, 12 were >2σ high, etc."

### Client interpolation for arbitrary σ

The user's σ slider is a continuous value (today 0.5 to 4.0 in 0.1 increments). The server's counts are at five fixed thresholds. The client interpolates linearly:

```ts
function countAtSigma(counts: number[], sigma: number, thresholds: number[]): number {
  if (sigma <= thresholds[0]) return counts[0];
  if (sigma >= thresholds[thresholds.length - 1]) return counts[counts.length - 1];
  // find the bucket sigma falls in
  let i = 0;
  while (i + 1 < thresholds.length && thresholds[i + 1] < sigma) i++;
  const t = (sigma - thresholds[i]) / (thresholds[i + 1] - thresholds[i]);
  return counts[i] + (counts[i + 1] - counts[i]) * t;
}
```

Worked example from the brief: counts `[876, 62, 12, 1, 0]` at thresholds `[1, 1.5, 2, 2.5, 3]`, sigma 1.25 → bucket [0..1], t=0.5 → `876 + (62 - 876) * 0.5 = 469`. ✓

A more faithful model (gaussian tails decay exponentially) would interpolate `log(count)`. At sigma 1.25 with the same counts: `exp(log(876) + (log(62) - log(876)) * 0.5) ≈ 233`. Probably more accurate. But at the chart's sized-dot resolution the difference is invisible. Ship linear; switch to log-linear if the visualization looks lumpy.

### Render: sized dots on the band edges

For each host, each tick, render up to two dots:

- **Above-band dot**: position `(ts, cpu_avg + sigma * cpu_sd)`, count = `interpolate(anomalies_above, sigma)`.
- **Below-band dot**: position `(ts, cpu_avg - sigma * cpu_sd)`, count = `interpolate(anomalies_below, sigma)`.

Visual contract:

- Visible only when interpolated count ≥ 1.
- Radius: `r = clamp(1.5 + log10(count + 1) * 1.5, 1.5, 8)`. Count=1 → r=1.95, count=10 → r=3, count=100 → r=4.5, count=1000 → r=6, capped at r=8.
- Color: red (matches existing anomaly convention).
- Opacity: `min(0.4 + log10(count + 1) * 0.15, 0.95)` so faint ticks read as faint.

The dot follows the band as the user drags σ. Slider becomes a "noise floor" control: at σ=1, every tick has dots; at σ=3, only the genuinely weird ones.

For dense regions, adjacent dots can visually overlap — that's fine. Recharts will draw them as overlapping circles and the eye reads "high anomaly density here." If the chart starts looking noisy under sustained outage, switch to per-pixel-column binning client-side; not needed by default.

## Dashboard rendering implications

Component-by-component, what changes when the wire moves from raw events to aggregate ticks:

| Component | Today (raw) | After (aggregate) |
|---|---|---|
| Total events | derived from `live.length` | from `globals.events_ingested_total` |
| Hosts | `useCurrent(live, { host: 'unique' })` | unchanged — same hook, same column |
| Event rate | `useCurrent({ cpu: 'count' }, { tail: '1m' }) / 60` | `globals.events_per_sec` direct |
| Evicted | `live.on('evict', cb)` counter | `globals.evicted_total` direct |
| Rolling 1m avg | `useCurrent(live, { cpu: 'avg' }, { tail: '1m' })` | `useCurrent(live, { cpu_avg: 'avg' }, { tail: '1m' })` — weighted by `cpu_n` ideally |
| EMA trend | `live.smooth('cpu', 'ema', { alpha })` | `live.smooth('cpu_avg', 'ema', { alpha })` |
| Anomalies count | derived from baseline filter | sum `interpolate(anomalies_above[h] + anomalies_below[h], sigma)` per host per tick over window |
| CPU per-host line (avg) | from baseline | `cpu_avg` column directly |
| CPU per-host band (±σ) | `avg ± sigma * sd` from baseline | `cpu_avg ± sigma * cpu_sd` from wire |
| Anomaly dots | per-event red dot | per-tick sized dot on band edge (this spec) |
| Raw scatter (showRaw) | every CPU sample as dot | the toggle either goes away or becomes "show min/max" — see below |
| Anomaly bar chart (15s buckets) | bucket count of outliers | bucket sum of `interpolate(...)` across the bucket's ticks |
| Per-host requests line | smoothed raw requests | `requests_avg` column directly |
| Logs table (recent events) | last 20 raw events | needs replacement — see below |

### Two visible UI changes worth flagging

**1. The "show raw samples" toggle.** Today it overlays every CPU sample as a faint scatter dot. With aggregate data there are no per-sample points to show. Two options:

- Drop the toggle entirely. The smoothed line + band already convey the data.
- Repurpose as "show min/max": per-tick, render two extra dots at `(ts, cpu_min)` and `(ts, cpu_max)`. Requires server to send `cpu_min` and `cpu_max` per tick (two extra fields, trivial).

I'd default to the second — it preserves the user's "show me the underlying texture" affordance, just at tick resolution instead of sample resolution.

**2. The logs table.** Today shows the last 20 raw events. With aggregates there are no raw events. Three options:

- Last 20 *aggregate ticks* — `{ts, host, cpu_avg, cpu_sd, cpu_min, cpu_max, cpu_n}` per row. Reads as a "live table of per-host stats."
- Last 20 *anomaly events* — only ticks where `anomalies_above + anomalies_below > 0` at the user's σ. Reads as an alerts feed.
- Both, in tabs.

I'd lean toward the anomaly-events feed — it's the most actionable. A future "tail raw events" feature can be a separate sparse-rate stream that the server only sends to clients with that view open.

### What stays exactly the same

- The σ slider. Purely client-side; re-interpolates counts on every drag.
- The bands UI. Just sourced from `cpu_avg`/`cpu_sd` instead of computed via `baseline()`.
- Host toggles. Host discovery via `useCurrent(live, { host: 'unique' })` works on the aggregate stream too.
- Connection status indicator. Same WS protocol.
- Pond pipeline conventions on the client: `partitionBy('host')` on the aggregate stream is still meaningful — each host's ticks are its own series. `tail`/`reduce`/`smooth` all apply.

## Edge cases & open questions

**Tick alignment across hosts.** If host A's tick fires at t=1000ms and host B's at t=1099ms, the wide-row Recharts data has rows that aren't aligned on the time axis. Cleanest fix: **emit on a synchronized tick clock** — every host's frame for a given tick has the same `ts`. Saves the client from materialising or interpolating client-side.

**Per-tick `cpu_avg` weighted by `cpu_n` for rollups.** When the client computes "rolling 1m avg of cpu_avg" via `useCurrent`, it's averaging averages. Mathematically wrong if `cpu_n` varies tick-to-tick. Right computation: `sum(cpu_avg * cpu_n) / sum(cpu_n)` over the window. Either:
- Client does this manually (the right place — it's a presentation choice).
- Server emits a "rolling 1m avg over last 60 ticks" pre-computed. Probably overkill for one stat.

I'd ship the manual client computation and let the dashboard agent flag if it gets noticeable on the page-summary card.

**Threshold list bounds.** User's σ slider today goes 0.5 to 4.0. Server thresholds default to `[1, 1.5, 2, 2.5, 3]`. Below 1 and above 3 the client clamps to the endpoints (returns `counts[0]` or `counts[length-1]`). Reasonable for an MVP — most ops dashboards don't need σ < 1 or σ > 3 visibility. If a deployment needs different ranges, the threshold list is server-config.

**Backpressure.** At 100 hosts × 5 ticks/sec the wire is ~500 host frames/sec plus ~5 global frames/sec. Each host frame is ~17 numeric fields plus arrays — call it ~250 bytes JSON, less binary. ~125KB/sec per WS client. WebSocket should handle this easily; backpressure isn't a concern at this rate. M4's slow-client handling already covers the pathological case.

**Snapshot size.** A 5-minute window at 5 ticks/sec/host × 100 hosts is 150,000 host ticks. At 250 bytes each that's ~37MB. Significant for snapshot-on-connect; M4 should measure. If too slow, ship a smaller snapshot window (e.g., 30s) and let the chart fill in over time, or compress the snapshot frame (gzip on the WS, easy win).

**Schema versioning.** Adding a new aggregate column (say `cpu_p99`) means coordinated changes on producer, aggregator, and dashboard. The schema-as-protocol convention already in place handles this — `as const` schema is shared via `packages/shared`, all three tiers compile-break together.

## Pointers

Existing code worth reading before implementing:

**Dashboard side** (`pjm17971/pond-ts-dashboard`, currently `packages/web/` of the experiment):
- [`src/useDashboardData.ts`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/packages/web/src/useDashboardData.ts) — the pond pipeline, numbered steps. Sections 7 (CPU bands) and 13 (requests) are the ones whose inputs change most.
- [`src/Chart.tsx`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/packages/web/src/Chart.tsx) — Recharts adapter. The Scatter overlay for anomaly dots is what we're replacing.
- [`src/sections/PageSummary.tsx`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/packages/web/src/sections/PageSummary.tsx) — the stats that change source.

**Aggregator side** (current state in `packages/aggregator/`):
- [`src/fanout.ts`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/packages/aggregator/src/fanout.ts) — current per-event broadcast. The aggregate path replaces this.
- [`src/snapshot.ts`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/packages/aggregator/src/snapshot.ts) — current snapshot serialisation. The aggregate snapshot is the same envelope shape, different rows.

**Cross-cutting:**
- [Friction notes M1](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M1.md) and M2 — operational wishlist items the aggregate work might also satisfy.
- The build plan: `Notes/Projects/Pond/gRPC experiment build plan.md` — M3 is the throughput characterisation that surfaces whether the aggregate-stream model has the headroom we hope.

## Summary of what I'd ship for v1

- Per host per tick: `{ts, host, cpu_avg, cpu_sd, cpu_n, anomalies_above[], anomalies_below[], requests_avg, requests_sum, requests_n}`. ~17 numeric fields, ~250 bytes JSON.
- Optional: `cpu_min`, `cpu_max` per tick for the "show extremes" toggle replacement.
- Per tick global: `{ts, events_ingested_total, events_per_sec, evicted_total}`.
- Server config (snapshot frame): `thresholds: [1, 1.5, 2, 2.5, 3]`.
- Synchronized tick clock across hosts (same `ts` for all hosts in a given tick).
- Snapshot envelope: same shape as today, rows are aggregate ticks not raw events.

Dashboard side picks up the changes in approximately 4 files (data hook, chart, page-summary, logs table) plus a small interpolation helper. The pond pipeline keeps its shape.

The eventual `@pond-ts/server` API for "aggregate this LiveSeries by partition over a tick interval" should ship something like this as the canonical aggregate output — `outliersAt: number[]` thresholds, weighted-mean preservation via `_n`, snapshot+append protocol baked in. The experiment's job is to validate the shape; the library's job is to make it default.
