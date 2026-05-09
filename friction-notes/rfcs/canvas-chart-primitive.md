# RFC: `@pond-ts/charts` — a streaming-first canvas chart primitive

**Status:** draft, awaiting library-agent review
**Author:** the gRPC experiment agent (Claude)
**First raised:** PR #28's M3.5 step-7 work (the firehose-rate dashboard surfaced an SVG cliff that retention shrinkage + chart memo throttling couldn't fix)
**Origin friction notes:**
- [`friction-notes/M3.5.md`](../M3.5.md) — "Recharts as the dashboard's render bottleneck — case for `@pond-ts/charts`"
- This RFC supersedes that section now that the experiment has shipped a working in-tree canvas primitive (PR #37) and discovered the design dead-ends along the way.
**Prototype:** [`packages/web/src/CanvasChart.tsx`](../../packages/web/src/CanvasChart.tsx) — the in-experiment implementation that the dashboard now uses by default. Drop-in replacement for the prior `Chart.tsx` (Recharts SVG); same `Props` shape.
**Proposed pond surface:** new sibling package `@pond-ts/charts` exporting (at least) a `CanvasChart` component that accepts pond outputs as data props.

## TL;DR

A canvas-based time-series chart primitive that takes pond-shaped data as input and renders in O(1) DOM nodes per chart regardless of point count. Replaces Recharts (or any SVG-based charting) for the streaming-with-many-points-and-no-tooltip use case the dashboard hit. The experiment shipped a working version that survived a 5× heap reduction and indefinite-runtime stability test; this RFC captures the design + traps so the library version doesn't relearn them.

```tsx
import { CanvasChart } from '@pond-ts/charts';

<CanvasChart
  series={data.cpuChartSeries}    // ChartSeries[] — { name, color, points, dashed?, opacity?, ... }
  bands={data.cpuBands}            // ChartBand[]  — { name, color, upper, lower, opacity? }
  dots={data.cpuDots}              // ChartDots[]  — { name, color, points, radius? }
  tStart={data.tStart}
  tEnd={data.tEnd}
  yMin={0.2}                       // initial domain; auto-extends if data exceeds
  yMax={0.9}
  yFormat={(v) => `${(v * 100).toFixed(0)}%`}
/>
```

The dashboard's heap went from "OOMs in 1 minute at firehose × 10 hosts" to "plateaus around 50 MB indefinitely" with **no other change** beyond swapping Recharts for this primitive.

## Motivation

The M3.5 dashboard hits a hard wall on Recharts (or any SVG-based chart) the moment streaming + N hosts + non-trivial point counts compose:

| Per-render SVG node count at firehose × 10 hosts × 5min window |        |
| -------------------------------------------------------------- | ------ |
| Per-host smoothed line (1500 points × scatter dot per point)   | ~30k   |
| Per-host ±σ band edges (10 hosts × 1500 polygon points)        | ~15k   |
| Per-host min/max envelope (20 hosts × 1500)                    | ~30k   |
| Anomaly Scatter circles                                        | ~1500–1700 |
| **Total per-chart**                                            | **~75–80k** |

Two distinct failure modes appear at this scale, both hit during M3.5's iteration:

1. **Renderer OOM.** SVG nodes are real DOM nodes. ~75k of them retained for the visible window plus React's reconciliation overhead pushed Chrome's renderer past its memory budget. Symptom: dashboard "dies" — eval times out, then the tab crashes.
2. **Main-thread starvation.** Even when memory's fine, Recharts' reconcile cost grew faster than 1× linearly in points × series. At firehose rate the chart memo's *own* work was 7–37 ms (well within budget) but the next paint took 1–5 seconds — recharts was the bottleneck.

The experiment chased SVG-cliff mitigations through several iterations: SVG node-count cuts (`TARGET_CHART_POINTS` 1500 → 500 → 250), per-Line `<Scatter>` suppression at high density, snapshot throttle 200 ms → 500 ms, hand-rolled bucketing for the bars memo, `React.memo` on the chart components. Each step bought minutes, not survival. The structural fix is to stop allocating DOM per data point.

PR #37's canvas primitive is that structural fix: 1 `<canvas>` per chart, all data drawn in one `useLayoutEffect` pass. Heap measurements before vs. after, sustained 50/s × 10-host load:

| Metric                  | Recharts     | Canvas              |
| ----------------------- | ------------ | ------------------- |
| Baseline used heap      | 166 MB       | **40 MB**           |
| DOM nodes (per chart)   | ~1,400       | **~5**              |
| SVG nodes (per chart)   | ~1,400       | **0**               |
| Sustained-load survival | 1–5 minutes  | **indefinite (8+ min plateau, no growth)** |

The library version pays back across every dashboard inside the team that hits the same fan-out × point-count regime. Recharts is the right shape for static / smaller / interactive charts; the canvas primitive is the right shape for streaming feeds with hundreds of points × tens of series and no tooltip / zoom requirement.

## Proposed API surface

### Component props (drop-in for the experiment's `Chart.tsx`)

```ts
type Props = {
  title: string;
  series: ChartSeries[];
  bands?: ChartBand[];
  dots?: ChartDots[];
  /** Time domain. Both required to render; `null/undefined` → empty state. */
  tStart?: number;
  tEnd?: number;
  /** CSS px number or percent template (`'100%'`, `'50%'`). Default `'100%'`. */
  width?: number | `${number}%`;
  height?: number;        // default 220
  /** Initial y-domain. **Auto-extends** if data exceeds; not a hard cap. */
  yMin?: number;
  yMax?: number;
  /** Formatter for y-axis tick labels. Default `(v) => `${(v * 100).toFixed(0)}%``. */
  yFormat?: (v: number) => string;
};

type ChartPoint = { ts: number; value: number | undefined };
type ChartSeries = {
  name: string;
  color: string;
  points: ChartPoint[];
  dashed?: boolean;        // dash pattern [4, 3]
  width?: number;          // line stroke width, default 1.5
  opacity?: number;        // default 0.95 solid / 0.7 dashed
  stat?: string;           // legend-label stat ("54%")
  hideFromLegend?: boolean;
};
type ChartBand = {
  name: string;
  color: string;
  upper: ChartPoint[];
  lower: ChartPoint[];
  opacity?: number;        // fill opacity, default 0.12
};
type ChartDots = {
  name: string;
  color: string;
  points: ChartPoint[];
  radius?: number;         // default 2.5
};
```

### What changes for the library version

The experiment's `Chart.tsx` and `CanvasChart.tsx` share these `ChartSeries`/`ChartBand`/`ChartDots` types — they were factored to be renderer-agnostic exactly so the swap was a one-line import change in section components. **Don't lose this in the library version.** A different prop shape forces every consumer to re-derive their data.

The library should additionally export:

- **Pond-aware data adapters.** The experiment's `useDashboardData` hook produces `ChartSeries`/`ChartBand`/`ChartDots` from `aggSnapshot.partitionBy('host').aggregate(Sequence.every(...))` outputs. Common shape across any pond consumer; worth a helper. Sketched API:

  ```ts
  import { fromPartitioned } from '@pond-ts/charts/adapters';

  const series = fromPartitioned(downsampledPerHost, {
    valueColumn: 'cpu_avg',
    colorMap: hostColors,
    bucketMs: aggBucketMs,            // for gap-marker injection (see below)
    nameStat: (rows) => `${(rows.at(-1)?.cpu_avg ?? 0 * 100).toFixed(0)}%`,
  });
  ```

  The bucket-size argument is what lets the adapter **emit explicit gap markers** for pond's "no row at this bucket" silences (see "Gap detection" below — this is the experiment's most-relearned lesson).

- **Tick helpers** — `niceTimeTicks(tStart, tEnd, target)` and `niceValueTicks(lo, hi, target)`. Pure functions; the experiment ships its own (~30 LOC each). Worth exposing because a library that owns `Sequence.every(...)` semantics has the right primitives to compute aligned tick boundaries.

## Implementation notes (the traps)

These are the things the experiment got wrong before getting them right. Each one cost iteration time; documenting so the library version doesn't repeat.

### 1. Gap detection lives in the data layer, not the chart

The chart's contract is "honour explicit gap markers" (`!Number.isFinite(p.value)`). It should NOT try to detect gaps from time-distance heuristics in the renderer.

The experiment's first attempt added an "if consecutive points are more than `1.5% × span` apart, treat as a gap" heuristic inside `CanvasChart`. **That's the wrong abstraction.** What counts as "too far" depends on the data's expected cadence — an annual-trend chart over monthly samples should connect points the dashboard's 5-second feed would obviously treat as silence. The chart can't answer that question; the application can.

Moved into `useDashboardData`'s memos: when consecutive rows are more than `1.5 × aggBucketMs` apart (the cadence pond's `aggregate(Sequence.every(...))` runs at), inject one `value: undefined` marker between them. The chart sees the marker, lifts the pen, no bridging.

This is exactly the kind of thing the `fromPartitioned` adapter above should encapsulate — if the adapter knows the bucket size, it can inject gap markers at known-empty buckets without the consumer having to think about it.

### 2. `Number.isFinite`, not `value != null`

`typeof NaN === 'number'`, so `value != null` lets NaN through. `lineTo(NaN, NaN)` doesn't skip — canvas treats it as "rest pen here," visually bridging the surrounding defined points. The dashboard's bridging bug was deterministic on streams where pond's reducers occasionally emit NaN under degenerate bucket conditions.

`Number.isFinite(value)` rejects null, undefined, NaN, ±Infinity uniformly. Use it everywhere — line drawing, dot overlay, anomaly dots, band segmentation, y-domain min/max computation.

### 3. Y-domain overrides should *widen*, not cap

The first canvas implementation treated `yMin`/`yMax` as a hard domain. Data exceeding `yMax` drew at negative canvas y-coords and disappeared off the top of the canvas. (Recharts' SVG quietly let pixels overflow; canvas clips to its bounds.)

Fix: treat overrides as the *initial* domain. Auto-extend if data exceeds. The override now means "start at least this wide" rather than "render exactly this band":

```ts
const dataMin = Math.max(0, lo - pad);
const dataMax = hi + pad;
return {
  yMin: yMinOverride != null ? Math.min(yMinOverride, dataMin) : dataMin,
  yMax: yMaxOverride != null ? Math.max(yMaxOverride, dataMax) : dataMax,
};
```

### 4. X-axis ticks anchor to wall-clock boundaries, not window fractions

First-pass implementation placed ticks at fixed proportions of `[tStart, tEnd]` (0%, 20%, …, 100%). As the window slid each WS frame, every tick's underlying timestamp shifted by ~200 ms; `toLocaleTimeString` rounds to seconds; rendered labels barely changed. The user noticed: "it's funny how the time axis labels stay still."

Fix: pick a step interval from `{1s, 2s, 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, …}` such that ~5–6 ticks land in the visible window. Anchor each tick to a natural wall-clock multiple (`Math.ceil(tStart / step) * step`). Each tick now maps to a fixed wall-clock time; as the window advances, x-positions slide left, labels disappear off the left edge, new ones appear from the right at the next minute boundary.

Same logic works at any zoom — 5-min window picks 1-minute ticks, 30-second window picks 5-second ticks.

### 5. Synchronous setState in `useLayoutEffect` is the cascading-render anti-pattern

The first `ResizeObserver` setup did:

```ts
useLayoutEffect(() => {
  // ...
  setContainerWidth(el.getBoundingClientRect().width);  // synchronous setState in effect
  const ro = new ResizeObserver((entries) => { ... });
  // ...
});
```

ESLint's `react-hooks/set-state-in-effect` flagged this; it's right. ResizeObserver fires once after the first layout pass with the initial measurement, so the synchronous read isn't needed at all:

```ts
const [measuredWidth, setMeasuredWidth] = useState(0);
useLayoutEffect(() => {
  const ro = new ResizeObserver(([entry]) => {
    const w = entry.contentRect.width;
    setMeasuredWidth(prev => prev !== w ? w : prev);
  });
  ro.observe(el);
  return () => ro.disconnect();
}, []);
```

One short-lived empty-canvas frame on mount, then the observer fires and the real paint happens. Empty-state branch (`if (containerWidth <= 0) return;`) handles the brief gap.

### 6. `React.memo` is required for streaming-data charts

The dashboard re-renders at the WS frame rate (5 fps for `latestGlobals` / `counters` updates), but the chart's data props only change at the snapshot throttle's 500 ms cadence. Without `React.memo`, recharts (and any chart) reconciles 5 times per second producing fresh path strings even when underlying data is unchanged.

Wrap the chart in `React.memo` (default shallow-compare is sufficient) and have the data layer return stable refs for unchanged memo outputs. The dashboard's `useDashboardData` returns memoized `cpu.series` / `cpu.bands` / `cpu.dots` arrays whose identity only changes when the snapshot does. Without that pairing the memo is useless.

### 7. DPR scaling at draw time, not at canvas construction

The right idiom:

```ts
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(displayWidth * dpr);   // backing buffer
canvas.height = Math.round(displayHeight * dpr);
canvas.style.width = `${displayWidth}px`;        // CSS size
canvas.style.height = `${displayHeight}px`;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);          // draw in CSS px
```

Sharp on Retina without doubling the line-drawing math. Setting `canvas.width` resets the context state; do it once per resize, not per draw.

### 8. Dot suppression at high density

Per-Line scatter dots are useful at sparse densities (an isolated defined value with `connectNulls={false}` would otherwise be invisible) but redundant when the line is dense (every point is connected to its neighbour). The experiment's `SCATTER_DOT_THRESHOLD = 60`: skip dots when `series.points.length > 60`. Cuts the per-Line dot count to zero in the firehose case; preserves the marker behaviour where it matters. Worth keeping; the threshold is empirically right at typical chart widths.

### 9. Single `useLayoutEffect`, draw everything in order

Rather than separate effects per layer, the experiment does grid → bands → lines → line-dot overlays → anomaly dots → axis labels in one synchronous pass. Easier to reason about z-order, easier to ensure consistent canvas state (`globalAlpha`, `setLineDash`), faster than multiple effects. ~250 LOC for the whole draw routine.

## What's intentionally NOT in v1

- **Tooltip on hover.** The dashboard didn't use one. Implementing it requires an HTML overlay layer (the canvas can't do per-element hit-testing efficiently); ~200 additional LOC for binary-search-by-x + crosshair line + popup positioning. Worth it if any consumer wants it; not needed for the streaming-monitor case.
- **Zoom / pan.** Static window matches the dashboard's "last 5 minutes" model. Brushable / zoomable variants are a separate primitive — once you have pan/zoom you also need wheel-event capturing, gesture state, etc.
- **Animation on data updates.** `isAnimationActive: false` was the convention even on the SVG side. Streaming charts updating 2–5 fps don't benefit from interpolated transitions; they make the chart feel laggy.
- **Streaming decimation policy.** The dashboard does its own `aggregate(Sequence.every(bucketMs), {...})` upstream of the chart to bound point count. The chart itself shouldn't decide what to drop.
- **Cross-chart sync (linked tooltips, zoom-shared, etc.).** Out of scope for v1; orthogonal complexity that grows with the consumer count.

## Performance techniques learned from uPlot

[uPlot](https://github.com/leeoniya/uPlot) is the fastest 2D-canvas charting library in the JS ecosystem. The experiment did **not** adopt it (third-party dep + opinionated data shape that doesn't fit pond's outputs), but we read the source ruthlessly to extract everything portable. Below is the ranked list of techniques to consider, each with a uPlot citation so the library author can verify against their source.

The framing throughout: **uPlot is a general-purpose library**, so most of its perf wins target scales it has to support (100k+ points, 60 fps streams). The library version of `@pond-ts/charts` targets a narrower band — the streaming dashboard case the experiment exercised. Many uPlot techniques don't pay back at our scale; flagging them honestly is as useful as listing the ones that do.

### High-ROI ports (do these in v1)

**1. Px-align integer rounding for crisp 1-px lines.** uPlot's `pxRound` rounds all pixel coords to integers, plus a `(width % 2) / 2` translate when stroking 1-px lines so the stroke centres on a pixel boundary instead of straddling two. Free legibility win on DPR=1 displays; invisible on Retina. uPlot: `pxRoundGen` in `src/paths/utils.js:242-244`, `incrRound` for plot bbox at `src/uPlot.js:780-783`. ~5-10 LOC port.

**2. Rollover time-axis labels at boundary crossings.** uPlot has a per-tick formatter table that prints `7:28:30` normally but `7/14\n7:28:30` (two-line) when a tick crosses a date boundary versus the prior tick. Our `toLocaleTimeString()` doesn't do this; a 5-minute window crossing midnight or an hour boundary ships ambiguous "12:01:00" labels with no context. uPlot: `src/opts.js:143-152`. ~10 LOC port.

**3. Pixel-density-based dot suppression** (replace constant threshold). The experiment's `SCATTER_DOT_THRESHOLD = 60` is a constant; uPlot does `idxs[1] - idxs[0] <= dim / (pointSpace * pxRatio)` so dots auto-disappear when there's <2px between them. Auto-adapts on resize. uPlot: `src/opts.js:750-761`. 1-line change.

### Bookmark for v2 (port when we add the feature)

**4. `closestIdx` for tooltip hit-testing.** When tooltips arrive, this is the entire hit-testing primitive: invert the x-scale at the mouse position to get a timestamp, binary-search the timestamp into the sorted X column, look up Y values per series at that index. 7 lines of bitwise binary search. uPlot: `src/utils.js:2-21`, used in `mouseMove → updateCursor` at `src/uPlot.js:2763`. ~50 LOC for the surrounding tooltip plumbing (DOM overlay, positioning).

**5. Path2D caching across redraws.** uPlot stores `Path2D` per series and only invalidates when (a) a scale changed range, (b) data was replaced, (c) the canvas was resized. Style state is recomputed cheaply per draw. At our scale this is overkill — at 250 points × 5 series × 2 fps the rebuild cost is negligible. **But:** when we hit a denser dashboard (30+ series, 5+ fps update), this is the path-rendering scaling lever. uPlot: `src/uPlot.js:1556-1567` (invalidation), `1608-1619` (cache check), `1656-1661` (style recompute). ~30-50 LOC port.

**6. `getOuterIdxs` — extend by one on each side.** Before drawing a series for visible range `[i0, i1]`, uPlot extends to `[i0-1, i1+1]` so the line connects past the plot edges and gets clipped, rather than ending exactly at the edge (which leaves a visible gap when the next data point is just offscreen). Only matters if/when consumers pre-window data upstream. uPlot: `src/uPlot.js:1583-1594`. Trivial port when relevant.

### Explicitly skip (cargo-cult risk if read casually)

The library author is going to read uPlot's source; these are the techniques that look impressive but do not pay back at our scale. Skipping them is correct, not lazy.

**Typed arrays for data layout (`Float64Array` X column + parallel Y columns).** At 2,500 total points the iteration cost difference between `for (const p of s.points)` over `{ts, value}` objects and `for (let i; i < n; i++)` over typed arrays is unmeasurable — both stream through CPU cache fine. The shape change ripples through every consumer. **Only port if (a) heap pressure becomes a bottleneck or (b) hit-testing is being added and the binary-search code wants the columnar shape.** uPlot's reasoning is right at 100k points; ours is different.

**Decimation (pixel-bucket min/max accumulator).** uPlot triggers decimation at `points >= 4 × pixelWidth` ≈ 2,400 points/series. Our cap is 250 (the chart memo's `TARGET_CHART_POINTS`). We hit decimation upstream via pond's `aggregate(Sequence.every(bucketMs), ...)`, not in the chart. **Skip unless rendering raw multi-week minute-resolution data on a single canvas.** uPlot: `src/paths/linear.js:51-117` (bucket accumulator), `src/paths/linear.js:4-15` (min/max/in/out drawing). 80 LOC of careful state machine if/when needed.

**Context-style cache (only set `strokeStyle` when changed).** Setting `ctx.strokeStyle = '#abc'` is microseconds. We do it ~5-10 times per draw at 2 fps = ≤20 sets/second. The bookkeeping isn't worth it. uPlot's payback comes from chained interactions with `Map<color, Path2D>` for bar charts (next item) — neither of which applies to us. uPlot: `src/uPlot.js:1335-1354`.

**`Map<color, Path2D>` batching for multi-color bars.** Groups bars by colour, builds one path per colour, emits one fill per colour. Saves state-set churn at hundreds-of-bars-per-frame. We don't have per-bar dynamic colouring (host colours are stable per row). The pattern is worth keeping mentally indexed for "30+ series sharing a small palette" later. uPlot: `src/paths/bars.js:103-117`.

**Convergence loop for axis padding.** Axis sizes depend on label widths depend on values depend on scale depends on plot rect depends on axis sizes — uPlot loops `convergeSize()` up to `CYCLE_LIMIT = 3` times. We hardcode `PAD_L = 42` and that works because percentages cap at 100% (3 chars). Reconsider only if the library is ever asked to format raw bytes ("12.3 GB"). uPlot: `src/uPlot.js:789-809`.

### What uPlot doesn't do (validates our design choices)

These are **absent** from uPlot, which is informative — uPlot is a perf-careful library, so its absences are signals about what *isn't* a hot path issue at smaller scales:

- **No `OffscreenCanvas` / Worker rendering.** uPlot is main-thread only. Confirms that "OffscreenCanvas + Worker" (see the dashboard's working-doc on this) is genuinely above-and-beyond uPlot territory, not table stakes. Library author shipping `@pond-ts/charts` with worker rendering would meaningfully exceed uPlot's perf model for the streaming-with-many-charts case.
- **No dirty-rect tracking.** Every commit calls `ctx.clearRect(0, 0, can.width, can.height)` and redraws the world. Path-cache (#5) makes this cheap because most series don't *rebuild*, just *re-stroke*. Don't bother with dirty-rects.
- **No `willReadFrequently` flag** on `getContext("2d")`. Implies they don't call `getImageData` (which we don't either). Skip.
- **No `requestAnimationFrame` throttling.** Uses `microTask` for batch coalescing. At our 2 fps cadence, irrelevant.
- **No incremental Path2D append on streaming data.** uPlot rebuilds paths from scratch on `setData` because it's a general library that doesn't know if data is streaming or replaced. **This is the architectural ceiling lift specific to our case** — see the relevant open question below.

## Open questions

1. **Should `@pond-ts/charts` ship a `BarChart` too?** The dashboard has one (the anomaly-bucket chart) that's still on Recharts because its SVG is bounded — bar count = 5min/15s = 20 buckets. Migrating is mechanical, not heap-pressured. Worth shipping for consistency or leave as Recharts-friendly?

2. **Tick computation primitives.** `niceTicks(lo, hi, target)` for values, `niceTimeTicks(tStart, tEnd, target)` for time. The library has the right home — pond knows about `Sequence.every(...)` semantics. Should it be built on top of pond's existing `Sequence` primitives somehow, or stay as standalone helpers?

3. **Adapter shape.** Sketched `fromPartitioned` above takes a `Map<string, RowArray>`. Pond's `partitionBy('host').aggregate(...).toMap(g => g.toPoints())` produces exactly this. Worth the adapter encoding the conversion + the gap-marker insertion (see implementation note 1)? The dashboard ended up writing this logic inline — would be ~80 LOC saved per consumer.

4. **The `width: '100%'` ResizeObserver setup.** Useful, but not pond-specific. Belongs in `@pond-ts/charts` or in a more general utility package? Same for the DPR-aware canvas sizing helper.

5. **TypeScript export shape.** The dashboard wants `ChartSeries` / `ChartBand` / `ChartPoint` types as part of the public API so the data adapter and the consumer's memo signatures can share the same types. Library should re-export.

6. **Theming.** The experiment uses CSS variables (`currentColor`, `rgba(127, 127, 127, 0.5)`) so the chart inherits the dashboard's light/dark mode. Library should preserve the convention; no hardcoded hex values for axis labels / grid lines.

7. **Append-only Path2D + ring buffer for streaming append.** This is the architectural ceiling lift uPlot doesn't take, and it's the place where a streaming-specific library can *exceed* a general-purpose one (see "What uPlot doesn't do" above).

   **The setup.** uPlot rebuilds a series' `Path2D` from scratch on every `setData` because it doesn't know if the new data is "ten random rows replaced" or "the leftmost row dropped + one new row appended." Its assumption is full replacement.

   **Our case is the latter.** A streaming dashboard's data update is structurally `[oldData[1..n], newPoint]` — drop one from the head, append one to the tail. **The geometry of every retained point is unchanged from frame to frame**; only the x-scale shifts (each point moves left by one bucket-width's worth of pixels). If we represent the per-series data as a ring buffer + a `Path2D` that tracks the buffer's tail, we can:
   1. On each new sample, `path.lineTo(xScale(newTs), yScale(newValue))` — append-only.
   2. When a sample falls off the left edge, leave the leading move in place — it'll be clipped by the canvas viewport.
   3. Periodically (every N samples or when the path's accumulated commands grow too long), rebuild from the current ring contents.

   The frame-to-frame draw cost is `O(1)` instead of `O(N)`. At our scale this is small relative savings; at higher streaming rates and longer windows it's the difference between holding 60 fps and not.

   **What's tricky:**
   - Path2D doesn't expose a "remove the head moveTo" operation, so we can't truly drop points from the front of an accumulated path. Either (a) accept that the path grows unboundedly and rebuild every K appends, or (b) keep two paths (active + spare), append to active, swap when active reaches K samples.
   - X-axis scale changes (window slides left) require re-rendering — the cached path's x-coords are now stale. Either accept this and rebuild, or apply a `ctx.translate(deltaX, 0)` per frame and rebuild only when the translate accumulates beyond a tolerance.
   - Resize / DPR changes invalidate everything. Same as uPlot's path cache — rebuild on these.
   - Gap markers (our `value: undefined` sentinel that the data layer injects at expected-bucket-but-empty positions) become annoying to incrementally add — appending a `null` between two `lineTo`s requires breaking the path into "before-the-gap" and "after-the-gap" subpaths or tracking a `move = true` state.

   **Open call:** is this worth the complexity for v1? I lean **no** — the bare canvas implementation already plateaus at 50 MB indefinitely under our load, and incremental Path2D would add ~150 LOC of state-machine + invalidation logic. It's the right *next* lever if streaming rate or window length grows past what uPlot's full-rebuild approach can support, but until then it's premature optimisation. Belongs in the RFC as a known opportunity, not a v1 blocker.

   uPlot's relevant code, for the library author who wants to confirm uPlot doesn't do this: `resetYSeries(true)` zeroes all `_paths` on data change at `src/uPlot.js:1556`+, called from `setData` at `src/uPlot.js:2316-2325`. There's no incremental append path anywhere in the source.

## Citations

- Experiment chart implementation: [`packages/web/src/CanvasChart.tsx`](../../packages/web/src/CanvasChart.tsx) (canvas, current default), [`packages/web/src/Chart.tsx`](../../packages/web/src/Chart.tsx) (Recharts, kept behind `?canvas=0` for comparison).
- The PR that shipped the swap with measurements: [PR #37](https://github.com/pjm17971/pond-grpc-experiment/pull/37) (now merged to main, see commit `fe7b92d`).
- Visual-bug fixes that surfaced the implementation traps:
  - Y-domain widening: commit `356e5f3`.
  - X-tick anchoring: commit `ee449fb`.
  - Gap detection in data layer (the architectural correction): commit `c8fef96`.
  - setState-in-effect lint fix: commit `f0db58d`.
- Friction-note pre-history: [`friction-notes/M3.5.md`](../M3.5.md) — "Recharts as the dashboard's render bottleneck" section pre-dates this RFC; it described the problem before there was a primitive to point at. Should now point at this RFC.
- Pre-canvas SVG-cliff mitigations the experiment tried (informative on what *doesn't* work):
  - `TARGET_CHART_POINTS` reductions (`useDashboardData.ts`).
  - `SCATTER_DOT_THRESHOLD` per-Line dot suppression at high density (`Chart.tsx`).
  - Snapshot throttle 200 → 500 ms (`useDashboardData.ts`).
  - Hand-rolled bars-memo bucketing replacing `TimeSeries.fromPoints` + `aggregate` (`useDashboardData.ts`'s `bars` memo).
  - `React.memo` on `Chart` and `BarChart` (the lattice-with-no-data-prop-changes case).

  Each was real progress but none were the structural fix — kept in tree for the comparison story; happy to delete once the canvas primitive is the obvious answer.
