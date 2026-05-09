/**
 * useDashboardData — the entire pond-ts pipeline behind the dashboard
 * lives here. Sections downstream are pure renderers of this hook's
 * return value.
 *
 * Reading order, top to bottom, mirrors the data flow:
 *
 *   1. LiveSeries (the only mutable buffer)
 *   2. eviction listener
 *   3. windowed snapshot         ← every chart reads from this
 *   4. host model + colour map
 *   5. CPU section derivations   (partitionBy → baseline → toMap)
 *   6. EMA trend (whole-series smooth)
 *   7. static threshold line     (useTimeSeries)
 *   8. high-CPU filter           (TimeSeries.filter)
 *   9. bar chart buckets         (aggregate either anomalies or alerts)
 *  10. Requests section          (partitionBy → smooth → toMap)
 *  11. roll-up scalars
 */
import { useMemo } from 'react';
import { useWindow } from '@pond-ts/react';
import { Sequence } from 'pond-ts';

/**
 * Target points per chart series. The CPU/Requests charts are ~420px
 * wide; rendering more than ~1 point per pixel is wasted SVG-node
 * churn that React+Recharts has to diff every frame. With a 5-min
 * window of 5 fps/host ticks (1500 raw rows), TARGET_CHART_POINTS=250
 * gives ~6× downsample with no visible loss (one point every ~1.7 px
 * at chart scale).
 *
 * History: 1500 (none) → 500 (M3.5 perf follow-ups) → 250 (this
 * commit). At firehose × 10 hosts the 500-point version still
 * produced ~25k SVG nodes per render and the main thread stayed
 * starved across 200ms throttle ticks; halving the per-series count
 * + suppressing the per-Line `<Scatter>` overlay at high point
 * densities (see Chart.tsx `SCATTER_DOT_THRESHOLD`) is the cheap
 * mitigation that bridges us to a canvas-based chart (the M5
 * `@pond-ts/charts` extraction).
 */
const TARGET_CHART_POINTS = 250;
import {
  type ChartBand,
  type ChartDots,
  type ChartPoint,
  type ChartSeries,
} from './Chart';
import { type Bar } from './BarChart';
import {
  DEFAULT_AGGREGATE_THRESHOLDS,
  HOSTS,
  type HostTick,
  type RankKey,
} from '@pond-experiment/shared';
import { countAtSigma } from './anomalyInterpolation';
import { PALETTE, WINDOW_MS } from './dashboardSchema';
import { type ConnectionStatus } from './useRemoteLiveSeries';
import {
  useRemoteAggregateSeries,
  type RemoteAggregateState,
} from './useRemoteAggregateSeries';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/live';

/**
 * Derive the `/live-agg` URL from `WS_URL` so a single `VITE_WS_URL`
 * env configures both endpoints. The single hook owner constructs
 * the URL once; consumers downstream (probe, bands) read state via
 * `data.aggregate`. `VITE_WS_AGG_URL` is the explicit override when
 * the two streams land on different hosts (e.g. M4 fan-out across
 * aggregators). URL parsing via the `URL` API rather than string
 * slicing — handles query strings (`?token=…`), trailing slashes,
 * and host-only URLs correctly. Falls back to a naïve append on
 * parse error.
 */
const AGG_WS_URL =
  import.meta.env.VITE_WS_AGG_URL ?? deriveAggregateUrl(WS_URL);

function deriveAggregateUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.replace(/\/$/, '');
    u.pathname = path === '/live' ? '/live-agg' : `${path}/live-agg`;
    return u.toString();
  } catch {
    return `${rawUrl}-agg`;
  }
}

export type ChartOpts = {
  /**
   * "Show ±σ bands" toggle — when on, the CPU chart renders dashed
   * line edges at `cpu_avg ± σ·cpu_sd` (the **1m baseline** stats)
   * per host plus the per-tick anomaly dots. When off, both the
   * dashed edges and the dots are hidden. The σ slider is only
   * meaningful with this on.
   */
  showBands: boolean;
  /**
   * "Show raw points" toggle — when on, the CPU chart renders two
   * stacked filled bands per host visualising the **per-tick (200
   * ms slice)** distribution of underlying samples:
   *   - inner band: `current_avg ± current_sd` (30% opacity)
   *   - outer band: `cpu_min … cpu_max` (10% opacity)
   * No dots on these bands; off-by-default to keep the first-time
   * render path light.
   */
  showRaw: boolean;
  /**
   * Width of the bands toggle's ±σ edges, in standard deviations.
   * Drives `cpu_avg ± σ·cpu_sd` over the 1m baseline. Only
   * meaningful when `showBands` is true.
   */
  sigma: number;
};

/**
 * Sample-count-weighted average of `cpu_avg` across enabled hosts in
 * a `latestPerHost` snapshot. Equivalent to the raw-event mean a
 * `useCurrent(liveSeries, { cpu: 'avg' }, { tail: '1m' })` call would
 * have produced over the un-aggregated stream.
 *
 * Why weighted: each host's `cpu_avg` is *its own* mean over its
 * events in the rolling 1m window; the count of events behind that
 * mean is `cpu_n`. A naïve mean-of-means would weight a host
 * emitting 10 events/s the same as one emitting 1000/s, biasing the
 * cluster headline. Weighting by `cpu_n` recovers the underlying
 * raw-event average exactly:
 *
 *   sum(cpu_avg_i × cpu_n_i) / sum(cpu_n_i) = mean of all raw events
 *
 * Returns `undefined` when no enabled host has weighted samples
 * (empty map, all hosts disabled, or every entry has cpu_n ≤ 0).
 */
export function computeWeightedRollingCpu(
  latestPerHost: ReadonlyMap<string, HostTick>,
  enabledHosts: ReadonlySet<string>,
): number | undefined {
  let weightedSum = 0;
  let totalN = 0;
  for (const [host, tick] of latestPerHost) {
    if (!enabledHosts.has(host)) continue;
    if (typeof tick.cpu_avg !== 'number') continue;
    const n = tick.cpu_n;
    if (typeof n !== 'number' || n <= 0) continue;
    weightedSum += tick.cpu_avg * n;
    totalN += n;
  }
  return totalN > 0 ? weightedSum / totalN : undefined;
}

/**
 * Cluster req/sec headline — sum of each enabled host's most recent
 * rate (`requests_sum / window_age_seconds`), gated on freshness
 * against `tEnd`.
 *
 * The aggregate wire **omits silent hosts**, but `latestPerHost`
 * preserves the last-known tick across silences (so the chart's
 * per-host lines don't disappear during brief gaps). For the
 * headline that's wrong: a host that genuinely went silent would
 * keep contributing its stale rate until eviction ages it out. The
 * staleness gate (`tEnd - tick.ts ≤ stalenessMs`) ensures host
 * failure / partition / shutdown reflects in the headline within
 * one staleness window, not minutes later.
 *
 * `stalenessMs` defaults to 3 s — generous given the wire's 200 ms
 * tick cadence (15× tickMs covers normal jitter without mistaking a
 * slow tick for a dead host).
 */
export function computeTotalReqPerSec(
  latestPerHost: ReadonlyMap<string, HostTick>,
  enabledHosts: ReadonlySet<string>,
  tEnd: number | undefined,
  stalenessMs = 3_000,
): number {
  if (tEnd == null) return 0;
  let total = 0;
  for (const [host, tick] of latestPerHost) {
    if (!enabledHosts.has(host)) continue;
    if (typeof tick.requests_sum !== 'number') continue;
    if (tick.requests_n < 1) continue;
    if (tEnd - tick.ts > stalenessMs) continue;
    const ageSec =
      typeof tick.window_age_seconds === 'number'
        ? tick.window_age_seconds
        : 60;
    const denom = Math.max(0.001, ageSec);
    total += tick.requests_sum / denom;
  }
  return total;
}

export type DashboardArgs = {
  disabledHosts: Set<string>;
  chartOpts: ChartOpts;
  /**
   * Per-connection top-N preference. Drives the WS control message
   * the dashboard sends after WS open / on dropdown change — server
   * filters per tick at broadcast time to only the top-N busiest
   * hosts by `rankBy`. Server-side hysteresis (margin 1) smooths
   * boundary churn; the dashboard receives N or N+1 hosts per
   * frame depending on stability.
   *
   * `null` clears the filter (server ships every host's row, the
   * pre-control-channel default behaviour). Numeric values are
   * server-clamped to `[1, max(hostCount, 1000)]`.
   */
  topN: number | null;
  /**
   * Rank metric for the top-N cut. Server sorts each tick's rows
   * by this column, descending, before applying the cut + hysteresis.
   * Restricted to 1m baseline metrics so the cut is "settled" rather
   * than thrashing on per-tick noise. See `shared/wire.ts.RankKey`.
   */
  rankBy: RankKey;
};

export type DashboardData = {
  // basic counters
  totalEvents: number;
  totalRequests: number | undefined;
  eventsPerSec: number | undefined;
  evictedTotal: number;

  // host model
  hosts: readonly string[];
  enabledHosts: Set<string>;
  hostColors: Record<string, string>;

  // connection state
  connectionStatus: ConnectionStatus;

  // CPU section
  rollingCpu: number | undefined;
  trendCpu: number | undefined;
  cpuChartSeries: ChartSeries[];
  cpuBands: ChartBand[];
  cpuDots: ChartDots[];
  cpuAnomalyCount: number;
  bars: Bar[];

  // Requests section
  reqSeries: ChartSeries[];
  totalReqPerSec: number;

  /**
   * Logs section — most recent host-tick frames from the aggregate
   * stream's windowed snapshot. Step 9 repurpose: pre-step-9 the
   * Logs section iterated raw events from `/live`'s `LiveSeries`;
   * post-retirement it shows the actual aggregate-wire flow (one
   * row per host per 200ms tick, newest first). Same "demonstrate
   * direct event iteration" affordance, just on the only live
   * stream the dashboard now subscribes to.
   */
  recentTicks: ReadonlyArray<HostTick>;

  // Aggregate stream state — the dashboard owns the single
  // subscription; `AggregateProbe` and section-7's bands consume it
  // through this slot.
  aggregate: RemoteAggregateState;

  /**
   * Per-host short window of `rankBy` values for the HostTable's
   * sparkline column. Last ~60 ticks (~12 s at default 200ms cadence).
   * Map key is host; value is chronologically-ordered samples.
   * Empty entries (host present in `currentTopHosts` but no recent
   * data in the windowed snapshot) are omitted; the table renders
   * an empty cell in that case.
   *
   * Computed in this hook off `aggSnapshot` so the table doesn't
   * need direct pond-ts knowledge.
   */
  sparklineData: ReadonlyMap<string, ReadonlyArray<number>>;

  // Shared time axis for both the CPU and Requests charts.
  tStart: number | undefined;
  tEnd: number | undefined;
};

export function useDashboardData(args: DashboardArgs): DashboardData {
  const { disabledHosts, chartOpts, topN, rankBy } = args;
  // Two independent overlay toggles + the σ slider.
  // - `showBands`: dashed-edges anomaly bands at `cpu_avg ± σ·cpu_sd`
  //   over the 1m baseline, plus anomaly dots.
  // - `showRaw`: filled distribution bands over the 200ms slice
  //   (inner `current_avg ± current_sd`, outer `cpu_min … cpu_max`).
  // - `sigma`: tunes the inner ±σ multiplier; only relevant when
  //   `showBands` is on.
  const { showBands, showRaw, sigma } = chartOpts;

  // 1. Aggregate stream — `/live-agg` mirror with the wire's per-host
  //    tick aggregates and per-tick globals. The dashboard's only live
  //    subscription post-step 9: `/live` is retired (the firehose
  //    didn't survive the WS round-trip at scale, see M3.5 friction
  //    notes), and every UI surface that used to read raw events
  //    re-derives off this stream instead — bands and smoothed line
  //    off `cpu_avg`/`cpu_sd` (steps 3–4), headline counters off the
  //    globals tick (step 6), snapshot history backfill on connect
  //    (step 8), and the rolling/EMA/total-requests/threshold-alert/
  //    logs surfaces all moved here in this commit.
  //
  //    The aggregate stream's `ConnectionStatus` drives the page-
  //    summary indicator — that's the only WS the dashboard depends
  //    on for any visible content.
  //
  //    `topN` ships a `{type:'set-top-n', n}` control message on WS
  //    open and on every prop change (no socket churn — see the
  //    hook's wsRef/topNRef plumbing). The server drops everything
  //    outside the busiest N hosts before broadcasting, applying
  //    rank-based hysteresis (margin 1) so the visible cut doesn't
  //    flicker when boundary hosts swap rank within a tick. The
  //    dashboard sees the cut already applied; chart memos iterate
  //    `hosts` and gate on `enabledHosts` without re-deriving a
  //    top-N slice client-side.
  const aggregate = useRemoteAggregateSeries(AGG_WS_URL, topN, rankBy);
  // Snapshot throttle. The wire delivers per-tick aggregate frames
  // every 200 ms, but the chart renders at the snapshot's cadence —
  // one redraw per throttle period across ~30 series + bands + dots.
  // At 200 ms (5 fps) the browser's render-engine GC fell behind the
  // SVG-subtree allocation rate at firehose × 10 hosts (renderer
  // killed at ~5-6 min). At 500 ms (2 fps) we halve the render-tree
  // allocation rate while staying visually-live for a demo
  // dashboard. The wire-meta panel below this still updates at
  // 5 fps because it reads from `aggregate.counters` directly, not
  // from the windowed snapshot.
  const aggSnapshot = useWindow(aggregate.liveSeries, '5m', { throttle: 500 });
  // The σ-threshold list the snapshot frame's `thresholds` field
  // delivers. Step-4 anomaly-density interpolation keys off this —
  // see `anomalyInterpolation.ts`. Falls back to the default while
  // the first snapshot is in flight.
  const aggregateThresholds = aggregate.thresholds;

  // 2. Eviction counter, event rate, total events — all sourced
  //    from the wire's globals tick (step 6). The previous version
  //    tracked them client-side (`live.on('evict', cb)` counter,
  //    `useEventRate(live, '1m')`, `snapshot.length`), which made
  //    the dashboard's headline numbers reflect the dashboard's
  //    locally-buffered view of the raw stream. With globals on the
  //    wire those headline numbers now reflect the **producer's
  //    actual gRPC throughput** at the aggregator's ingest hop —
  //    monotonic across reconnects, unaffected by retention, and
  //    independent of the down-sampling the wire does to ship one
  //    frame per tick. The "the dashboard sees the gRPC firehose"
  //    illusion the WIRE.md doc describes.
  const globals = aggregate.latestGlobals;
  const totalEventsGlobal = globals?.events_ingested_total ?? 0;
  const eventsPerSec = globals?.events_per_sec;
  const evictedTotal = globals?.evicted_total ?? 0;
  // Step 9 — total requests cumulative now ships in the globals tick
  // alongside `events_ingested_total`. Pre-step 9 the dashboard rolled
  // it up client-side off the raw `/live` firehose, which was the
  // path the wire-side aggregate redesign was supposed to eliminate.
  // `undefined` for pre-step-9 servers (the field is optional on
  // `GlobalsTick`); the Stat renderer falls back to "—".
  const totalRequests = globals?.requests_ingested_total;

  // 4. Host model: discovered live from the data via the aggregate
  //    stream's `latestPerHost` map (keys are the hosts that have
  //    emitted at least one tick frame). Filtered through HOSTS so
  //    the canonical declaration order drives palette assignment —
  //    a host's color stays the same whatever order the data
  //    arrives in. Hosts not in HOSTS won't render until added
  //    there (M2's real producer may force this).
  //
  //    Pre-step-9 this used `useCurrent(liveSeries, { host: 'unique' })`
  //    over the raw stream. With /live disabled the discovery moves
  //    to the aggregate stream — same hosts, same canonical
  //    filtering, refreshed at the aggregate's tick cadence.
  const hosts = useMemo(() => {
    if (aggregate.latestPerHost.size === 0) return [];
    return HOSTS.filter((h) => aggregate.latestPerHost.has(h));
  }, [aggregate.latestPerHost]);
  const enabledHosts = useMemo(() => {
    const set = new Set<string>();
    for (const h of hosts) if (!disabledHosts.has(h)) set.add(h);
    return set;
  }, [hosts, disabledHosts]);
  const hostColors = useMemo(() => {
    const map: Record<string, string> = {};
    HOSTS.forEach((h, i) => (map[h] = PALETTE[i % PALETTE.length]));
    return map;
  }, []);

  // 4b. Visible-hosts notes (no derivation needed). Server-side top-N
  //     (see `useRemoteAggregateSeries(url, topN)` above + the
  //     aggregator's `projectAppend`) already trims each broadcast
  //     frame to the top-N busiest by 1m baseline `cpu_avg`, so
  //     `latestPerHost` and `aggSnapshot` only carry rows for hosts
  //     that have been in the cut at some point. The CPU + Requests
  //     charts iterate `hosts` (HOSTS-declaration order, intersected
  //     with the wire's actual contents) and gate on `enabledHosts`
  //     for the user-toggle filter — no separate top-N memo runs
  //     client-side anymore.
  //
  //     Hosts that fall out of the cut keep their last-known tick in
  //     `latestPerHost` (the wire just stops shipping rows; the map
  //     doesn't drop them) and stay visible on the chart until they
  //     scroll off the 5min back-window. That's a visual quirk of
  //     the no-hysteresis cut — boundary hosts can pop in and out
  //     across ticks. A future hysteresis pass on the server
  //     (deferred, `friction-notes/M3.5.md`) will smooth this out.
  //
  //     The HostToggles UI still excludes hosts from the chart's
  //     `enabledHosts`, but the server can't see those toggles — a
  //     "disabled" host that's in the server-side top-N still ships
  //     its rows; the chart memos drop them via the `enabledHosts`
  //     gate below. Net effect: server sends ~5 hosts; the chart
  //     shows ≤5 (anything the user toggled off is hidden).

  // 5. Rolling 1m CPU avg across enabled hosts, sourced from the
  //    aggregate stream's `latestPerHost` map. See
  //    `computeWeightedRollingCpu` for the weighting math. Note:
  //    this rolls up across **all enabled hosts**, not just the
  //    top-5 plotted on the chart — the headline reflects the
  //    cluster a user has selected, even when the chart can only
  //    show the busiest few of those.
  const rollingCpu = useMemo(
    () => computeWeightedRollingCpu(aggregate.latestPerHost, enabledHosts),
    [aggregate.latestPerHost, enabledHosts],
  );

  // 6. Time axis pinned to the latest aggregate tick with a fixed
  //    back-window. Single source of truth — every chart path now
  //    sources from `/live-agg`.
  const tEnd = aggSnapshot?.last()?.key().timestampMs();
  const tStart = tEnd != null ? tEnd - WINDOW_MS : undefined;

  // 6b. Throttle-friendly view of "which hosts are in the latest
  //     tick the chart is rendering." Derived from `aggSnapshot`
  //     (which `useWindow` throttles to 500 ms) rather than
  //     `aggregate.currentTopHosts` (which the WS handler updates
  //     at 5 fps, the wire's full cadence).
  //
  //     Why this exists as a separate signal: the chart memo's
  //     pipeline (filter → partitionBy → aggregate → toMap → series
  //     construction) is the heaviest work in the dashboard. If we
  //     gate it on `aggregate.currentTopHosts`, every aggregate-
  //     append re-runs the pipeline regardless of the snapshot
  //     throttle, allocating fresh chart-row arrays at 5 fps. At
  //     top-5 hosts × 5 fps the allocation pressure outpaces V8's
  //     GC and the renderer OOMs in ~1 minute. Sourcing from
  //     `aggSnapshot` instead pins the chart's host-set to the
  //     same 500 ms cadence as everything else the snapshot drives.
  //
  //     The HostTable still uses `aggregate.currentTopHosts` (the
  //     5 fps signal) because that component's per-render work is
  //     small and the user wants instant table updates as ranks
  //     shift — a fresh frame's host set should appear without a
  //     half-second lag.
  const chartHostsSet = useMemo<Set<string>>(() => {
    if (!aggSnapshot || aggSnapshot.length === 0) return new Set();
    const last = aggSnapshot.last();
    if (!last) return new Set();
    const lastTs = last.key().timestampMs();
    const set = new Set<string>();
    // Iterate backwards from the tail; events at the same boundary
    // have identical ts (synchronised tick clock), so collect every
    // event with ts === lastTs and stop at the first older event.
    for (let i = aggSnapshot.length - 1; i >= 0; i--) {
      const e = aggSnapshot.at(i);
      if (!e) break;
      if (e.key().timestampMs() !== lastTs) break;
      const h = e.get('host');
      if (typeof h === 'string') set.add(h);
    }
    return set;
  }, [aggSnapshot]);

  // 7. CPU section — fully aggregate-driven. Per host:
  //
  //    - smoothed line (`cpu_avg`) at full host colour
  //    - inner band: cpu_avg ± σ × cpu_sd, host colour at 30%
  //      opacity, dashed edges
  //    - outer band: cpu_min … cpu_max (per-tick extrema), host
  //      colour at 10% opacity, dashed edges
  //    - anomaly dots placed at cpu_max (above-band) or cpu_min
  //      (below-band) — i.e., on the actual extreme value, not the
  //      smoothed band edge — when the σ-interpolated anomaly
  //      count crosses 1 at the user's slider value
  //
  //    Top-N filter: at firehose × 10-host wire the chart caps at
  //    the 5 enabled hosts with the highest current `cpu_avg`. The
  //    HostToggles UI still lets the user exclude hosts; the chart
  //    picks the N busiest of whatever's left. Keeps the visual
  //    legible without forcing the user to manually disable
  //    quieter hosts.
  const cpu = useMemo(() => {
    // Lightweight per-render diagnostic. `?perf=1` query param turns
    // it on; off in normal use because `console` lookups churn dev
    // logs at 5 fps. Splits the cost across pond's filter+partition,
    // pond's downsample (aggregate), the full-res anomaly scan, and
    // the chart-points assembly so we can localise regressions.
    const perf =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('perf') === '1';
    const t0 = perf ? performance.now() : 0;

    const series: ChartSeries[] = [];
    const bands: ChartBand[] = [];
    const dots: ChartDots[] = [];
    const allAnomalies: ChartPoint[] = [];
    // Bail before touching pond if the snapshot has no events. `aggregate(seq)`
    // on an empty source falls back to `series.timeRange()` for its bucket
    // range, and that's undefined when length is 0 — pond throws inside the
    // sequence walk. The dashboard's first render hits this every time
    // (initial WS connect → snapshot is empty until the first frame lands),
    // so the guard isn't an edge case, it's the boot path.
    if (!aggSnapshot || aggSnapshot.length === 0) {
      return { series, bands, dots, allAnomalies };
    }

    if (enabledHosts.size === 0 || chartHostsSet.size === 0) {
      return { series, bands, dots, allAnomalies };
    }

    // **Filter to enabled ∩ chart-hosts before partitioning.**
    // `chartHostsSet` is the latest-tick host set derived from
    // `aggSnapshot` (so it changes at the snapshot throttle's
    // cadence, ~500 ms — not the WS's 5 fps). This keeps the
    // expensive chart pipeline from re-running on every WS frame
    // when only the snapshot-throttled work needs to run; see the
    // `chartHostsSet` memo above for why this matters (renderer
    // OOM at top-5 × 5 fps without it).
    //
    // The HostTable model is "table is the chart's host selector":
    // rows in the table = lines on the chart. The two views can
    // diverge by up to one snapshot throttle period when the cut
    // changes, but at 500 ms that's invisible.
    const filtered = aggSnapshot.filter((e) => {
      const h = e.get('host');
      return (
        typeof h === 'string' &&
        enabledHosts.has(h) &&
        chartHostsSet.has(h)
      );
    });
    if (filtered.length === 0) {
      return { series, bands, dots, allAnomalies };
    }
    const partitioned = filtered.partitionBy('host');
    const tPart = perf ? performance.now() : 0;

    // Downsample for line/band rendering. Per-bucket reducers picked
    // to match each signal's semantic:
    //   - cpu_avg/cpu_sd → 'avg'  (smooth-of-smooth; the bucket's
    //     averaged statistic is the natural plot value)
    //   - cpu_n/n_current → 'last' (these are gates; the bucket's
    //     terminal sample-count is what the user sees as "current")
    //   - cpu_min → 'min', cpu_max → 'max' (spike preservation —
    //     pond's built-in min/max reducers do exactly the right
    //     thing here)
    // Bucket size derived from the visible window so the per-render
    // SVG node count tracks chart pixel width, not wire fan-out.
    // Anomalies array columns aren't reduced — pond's reducers are
    // scalar-only — so per-tick anomaly extraction runs separately
    // below over the full-res partitioned series.
    const aggBucketMs = Math.max(
      200,
      Math.ceil(WINDOW_MS / TARGET_CHART_POINTS),
    );
    const downsampledPerHost = partitioned
      .aggregate(Sequence.every(`${aggBucketMs}ms`), {
        cpu_avg: 'avg',
        cpu_sd: 'avg',
        cpu_n: 'last',
        n_current: 'last',
        cpu_min: 'min',
        cpu_max: 'max',
        // 200ms-slice distribution stats — averaged across the
        // downsample bucket. The "raw points" toggle plots
        // current_avg ± current_sd as the inner distribution band.
        // Bucket-averaging slightly blurs the per-tick spread but
        // that's fine for visualisation at chart scale.
        current_avg: 'avg',
        current_sd: 'avg',
      })
      .toMap((g) => g.toPoints());
    const tDownsample = perf ? performance.now() : 0;

    // Full-res rows per host — only used for the per-tick anomaly
    // scan below. Could fold into the aggregate above with a custom
    // reducer if pond ever grows array-column folds; today this is
    // the cleanest split.
    const fullResPerHost = partitioned.toMap((g) => g.toPoints());
    const tFullRes = perf ? performance.now() : 0;

    // Threshold list comes from the snapshot frame's `thresholds`
    // field. Fall back to the default while the first snapshot is
    // in flight — the array's contents won't matter then because
    // anomalies arrays haven't arrived either.
    const thresholds =
      aggregateThresholds.length > 0
        ? aggregateThresholds
        : DEFAULT_AGGREGATE_THRESHOLDS;

    for (const host of hosts) {
      if (!enabledHosts.has(host)) continue;
      if (!chartHostsSet.has(host)) continue;
      const color = hostColors[host];

      // ── Pass 1: per-tick anomaly dots (full resolution). Anomalies
      //    are sparse single-tick signals; plotting them at downsampled
      //    bucket boundaries would smear them and risk dropping them
      //    inside an all-zero bucket. Iterate every tick and emit a
      //    dot whenever the σ-bucketed count crosses 1.
      //
      //    Dots placed at the per-tick extreme value (`cpu_max` for
      //    above-band anomalies, `cpu_min` for below-band) rather
      //    than the band edge. The reading: the dot marks the
      //    actual high/low sample that broke through the band, so
      //    it sits where that sample is on the y-axis. Skip when
      //    the extreme isn't available (empty 200ms slice → null).
      const anomalyDots: ChartPoint[] = [];
      const fullRows = fullResPerHost.get(host) ?? [];
      for (const r of fullRows) {
        if (r.cpu_avg == null || r.cpu_sd == null) continue;
        // `kind: 'array'` columns are typed `ReadonlyArray<ScalarValue>`
        // (number|string|boolean) at the schema level; the wire contract
        // guarantees number arrays, so the cast is safe.
        const aAbove = (r.anomalies_above as ReadonlyArray<number>) ?? [];
        if (
          countAtSigma(aAbove, sigma, thresholds) >= 1 &&
          typeof r.cpu_max === 'number'
        ) {
          anomalyDots.push({ ts: r.ts, value: r.cpu_max });
        }
        const aBelow = (r.anomalies_below as ReadonlyArray<number>) ?? [];
        if (
          countAtSigma(aBelow, sigma, thresholds) >= 1 &&
          typeof r.cpu_min === 'number'
        ) {
          anomalyDots.push({ ts: r.ts, value: r.cpu_min });
        }
      }

      // ── Pass 2: line + band points from the downsampled bucket
      //    rows. Up to four overlay layers per host depending on
      //    toggles:
      //      - smoothed line: always (cpu_avg, gated on cpu_n >= 30)
      //      - showBands: dashed-line edges at cpu_avg ± σ·cpu_sd
      //        (1m baseline) — emitted as two `hideFromLegend`
      //        ChartSeries with `dashed: true`, NOT a filled band
      //      - showRaw inner: filled band at current_avg ±
      //        current_sd (200ms slice), 30% opacity, no edges
      //      - showRaw outer: filled band at cpu_min … cpu_max
      //        (200ms slice), 10% opacity, no edges
      const sigmaUpper: ChartPoint[] = [];
      const sigmaLower: ChartPoint[] = [];
      const distInnerUpper: ChartPoint[] = [];
      const distInnerLower: ChartPoint[] = [];
      const distOuterUpper: ChartPoint[] = [];
      const distOuterLower: ChartPoint[] = [];
      const smoothPoints: ChartPoint[] = [];
      let lastAvg: number | undefined;

      // Two independent gates per row:
      //
      //   - `liveGate`: `n_current >= 1` — the 200ms slice has at
      //     least one sample. Drives the smoothed center line, which
      //     plots `current_avg` (the 200ms-slice mean). Trades a
      //     little visual jitter for *responsiveness* — the line
      //     tracks bursts as soon as samples land in the slice,
      //     instead of lagging the 1m baseline mean by tens of
      //     seconds. (Pre-this commit the line plotted `cpu_avg`
      //     over the 1m baseline, which was very smooth but
      //     surprising next to the band edges: `cpu_sd` is far more
      //     responsive to outliers than `cpu_avg`, so the band
      //     widened around a burst while the center line just sat
      //     there.)
      //
      //   - `baselineGate`: `cpu_n >= MIN_SAMPLES` — the 1m baseline
      //     is warmed up enough that mean / sd are trustworthy.
      //     Drives the ±σ band edges (`cpu_avg ± σ·cpu_sd`). Pre-
      //     baseline-warmup the bands hold off; the responsive
      //     center line still plots.
      const MIN_SAMPLES = 30;
      const aggRows = downsampledPerHost.get(host) ?? [];
      for (const r of aggRows) {
        const liveGate = (r.n_current ?? 0) >= 1;
        const baselineGate = (r.cpu_n ?? 0) >= MIN_SAMPLES;
        // Center line — `current_avg` per 200ms slice. Plots whenever
        // the slice has data, even before the baseline warms up.
        if (liveGate && typeof r.current_avg === 'number') {
          smoothPoints.push({ ts: r.ts, value: r.current_avg });
          lastAvg = r.current_avg;
        } else {
          smoothPoints.push({ ts: r.ts, value: undefined });
        }
        // Baseline σ band edges. Independent of `liveGate` — the band
        // is the threshold reference, not the current value, so it
        // can render even when the current slice is empty (as long
        // as the baseline is warm).
        if (baselineGate && r.cpu_avg != null && r.cpu_sd != null) {
          sigmaUpper.push({
            ts: r.ts,
            value: r.cpu_avg + sigma * r.cpu_sd,
          });
          sigmaLower.push({
            ts: r.ts,
            value: r.cpu_avg - sigma * r.cpu_sd,
          });
        } else {
          sigmaUpper.push({ ts: r.ts, value: undefined });
          sigmaLower.push({ ts: r.ts, value: undefined });
        }
        // Distribution bands (showRaw toggle). Independent of the
        // cpu_n MIN_SAMPLES gate — they describe the per-tick
        // 200ms slice, not the 1m baseline. Gate on slice content
        // (`n_current >= 1`); empty slices ship null and render
        // as a gap.
        const sliceFilled = (r.n_current ?? 0) >= 1;
        // Inner distribution band: current_avg ± current_sd.
        // current_sd is null when n_current < 2 (variance
        // undefined); fall back to a zero-width band at
        // current_avg in that case so the band degenerates to
        // a line at the single observed value.
        const innerCenter =
          sliceFilled && typeof r.current_avg === 'number'
            ? r.current_avg
            : undefined;
        const innerSd =
          sliceFilled && typeof r.current_sd === 'number'
            ? r.current_sd
            : 0;
        distInnerUpper.push({
          ts: r.ts,
          value: innerCenter != null ? innerCenter + innerSd : undefined,
        });
        distInnerLower.push({
          ts: r.ts,
          value: innerCenter != null ? innerCenter - innerSd : undefined,
        });
        // Outer distribution band: cpu_min … cpu_max.
        distOuterUpper.push({
          ts: r.ts,
          value:
            sliceFilled && typeof r.cpu_max === 'number'
              ? r.cpu_max
              : undefined,
        });
        distOuterLower.push({
          ts: r.ts,
          value:
            sliceFilled && typeof r.cpu_min === 'number'
              ? r.cpu_min
              : undefined,
        });
      }

      series.push({
        name: host,
        color,
        stat:
          lastAvg != null ? `${(lastAvg * 100).toFixed(0)}%` : undefined,
        points: smoothPoints,
      });

      // showRaw distribution bands: outer first (renders behind),
      // inner on top. Filled, no dashed edges, no dots.
      if (showRaw && distOuterUpper.length >= 2) {
        bands.push({
          name: `${host}-dist-outer`,
          color,
          upper: distOuterUpper,
          lower: distOuterLower,
          opacity: 0.1,
        });
      }
      if (showRaw && distInnerUpper.length >= 2) {
        bands.push({
          name: `${host}-dist-inner`,
          color,
          upper: distInnerUpper,
          lower: distInnerLower,
          opacity: 0.3,
        });
      }

      // showBands ±σ edges — two dashed `hideFromLegend` series
      // (NOT a filled band). The legend already lists the host
      // via the smoothed line; the dashed edges are visual
      // context, not separate entries.
      if (showBands && sigmaUpper.length >= 2) {
        series.push({
          name: `${host}-sigma-upper`,
          color,
          points: sigmaUpper,
          dashed: true,
          width: 1,
          opacity: 0.7,
          hideFromLegend: true,
        });
        series.push({
          name: `${host}-sigma-lower`,
          color,
          points: sigmaLower,
          dashed: true,
          width: 1,
          opacity: 0.7,
          hideFromLegend: true,
        });
      }

      // Anomaly dots only emitted when bands toggle is on (they're
      // the "look here, this broke through the band" cue). Without
      // bands the dots have no reference frame; the distribution
      // band shows the spread but not the threshold.
      if (showBands && anomalyDots.length > 0) {
        dots.push({ name: host, color: '#e23b3b', points: anomalyDots });
        allAnomalies.push(...anomalyDots);
      }
    }

    if (perf) {
      const tEnd = performance.now();
      let dsRows = 0;
      let frRows = 0;
      for (const rs of downsampledPerHost.values()) dsRows += rs.length;
      for (const rs of fullResPerHost.values()) frRows += rs.length;
      // eslint-disable-next-line no-console
      console.log(
        '[cpu memo]',
        `part ${(tPart - t0).toFixed(1)}ms`,
        `down ${(tDownsample - tPart).toFixed(1)}ms`,
        `full ${(tFullRes - tDownsample).toFixed(1)}ms`,
        `assemble ${(tEnd - tFullRes).toFixed(1)}ms`,
        `total ${(tEnd - t0).toFixed(1)}ms`,
        `hosts:${downsampledPerHost.size}`,
        `down/host:${dsRows / Math.max(1, downsampledPerHost.size)}`,
        `full/host:${frRows / Math.max(1, fullResPerHost.size)}`,
        `series:${series.length}`,
        `dots:${dots.reduce((acc, d) => acc + d.points.length, 0)}`,
      );
    }

    return { series, bands, dots, allAnomalies };
  }, [
    aggSnapshot,
    aggregateThresholds,
    hosts,
    enabledHosts,
    chartHostsSet,
    hostColors,
    sigma,
    showBands,
    showRaw,
  ]);

  // 8. EMA-smoothed CPU trend across all enabled hosts (summary stat
  //    only). Sourced from the aggregate snapshot. Per-tick the
  //    cluster CPU is the **sample-count-weighted** average across
  //    enabled hosts (same formula as `rollingCpu`, applied per
  //    ts); the EMA runs across the resulting per-tick series.
  //
  //    Pre-step-9 this ran an unweighted `aggregate(every('200ms'),
  //    { cpu_avg: 'avg' })` then EMA, which Codex flagged as biased
  //    when hosts have different sample counts. Pond's built-in
  //    `'avg'` reducer is per-column unweighted; weighting needs
  //    either a custom function reducer (snapshot-side only in
  //    0.16) or the manual JS pass below. JS pass is fine here —
  //    one walk over the windowed snapshot per render, bounded by
  //    the same retention as the chart memos.
  const trendCpu = useMemo(() => {
    if (!aggSnapshot || aggSnapshot.length === 0) return undefined;
    // Group enabled-host events by ts; collect weighted sum + total
    // sample count per ts boundary.
    const perTs = new Map<number, { weightedSum: number; totalN: number }>();
    for (const e of aggSnapshot) {
      const host = e.get('host');
      if (typeof host !== 'string' || !enabledHosts.has(host)) continue;
      const cpuAvg = e.get('cpu_avg');
      const cpuN = e.get('cpu_n');
      if (typeof cpuAvg !== 'number' || typeof cpuN !== 'number' || cpuN <= 0) {
        continue;
      }
      const ts = e.key().timestampMs();
      const acc = perTs.get(ts);
      if (acc) {
        acc.weightedSum += cpuAvg * cpuN;
        acc.totalN += cpuN;
      } else {
        perTs.set(ts, { weightedSum: cpuAvg * cpuN, totalN: cpuN });
      }
    }
    if (perTs.size === 0) return undefined;
    const sortedTs = [...perTs.keys()].sort((a, b) => a - b);
    const alpha = 0.3;
    let ema: number | undefined;
    for (const ts of sortedTs) {
      const { weightedSum, totalN } = perTs.get(ts)!;
      if (totalN <= 0) continue;
      const wAvg = weightedSum / totalN;
      ema = ema === undefined ? wAvg : alpha * wAvg + (1 - alpha) * ema;
    }
    return ema;
  }, [aggSnapshot, enabledHosts]);

  // 9. Bar chart buckets: 15-second bins of anomaly dots. Round-trip
  //    the flat anomaly points back into a tiny TimeSeries via
  //    `fromPoints` so we can use pond's bucketing.
  //
  //    **Sort first.** `cpu.allAnomalies` is built by appending each
  //    host's dots in chronological order, but across hosts the
  //    concatenated array isn't sorted — host A's dots at ts T1, T2
  //    come before host B's at T1', T2' even when T1' < T2.
  //    `TimeSeries.fromPoints` requires non-decreasing timestamps
  //    and throws "row N is out of order" otherwise. Step 6's burst
  //    dynamics make this common (an active burst on host A and
  //    host B at the same tick produces interleaved timestamps
  //    after concatenation).
  //
  //    **Cap first.** Natural ceiling is 5m × 5 fps × N_hosts × 2
  //    dots ≈ 24k entries even at max anomaly density. If we're
  //    handed an array meaningfully larger, something upstream is
  //    broken; refuse rather than feed megabytes into `fromPoints`.
  //    Slice to the most recent `MAX_ANOMALIES` — the bar chart
  //    only shows the visible time-axis window anyway.
  //
  //    Threshold-mode (high-CPU alerts) was retired alongside the
  //    showBands toggle: with both ±σ and min/max bands always
  //    visible, the band overlay carries the "is anything hot?"
  //    signal directly and the static 70% reference line stopped
  //    pulling its weight.
  const bars: Bar[] = useMemo(() => {
    if (tStart == null || tEnd == null) return [];
    if (cpu.allAnomalies.length === 0) return [];
    // Bucket directly into a fixed-grid count array — skip pond's
    // `TimeSeries.fromPoints` + `aggregate(Sequence.every('15s'))`
    // path. The pond pipeline allocates one Event per anomaly dot
    // plus a TimeSeries clone per bucket; at high anomaly rates
    // (5 hosts × ~2 dots/tick × 1500 ticks visible ≈ 15k dots) the
    // memo runs every 500 ms and allocates ~4 MB per run for the
    // intermediate TimeSeries + buckets, mostly GC'd but creating
    // sustained pressure that the renderer was struggling with.
    //
    // Hand-rolled bucketing is O(N) over the input dots with one
    // Bar object per non-empty 15s slot; ~10× lighter on allocation
    // for the same output. The `anomalyTs.aggregate(...)` pattern
    // would still be the right primitive if pond's per-bucket
    // allocation cost shrinks, but for now this hot path is too
    // hot for it.
    const BUCKET_MS = 15_000;
    const MAX_ANOMALIES = 50_000;
    const dots = cpu.allAnomalies;
    const start = dots.length > MAX_ANOMALIES ? dots.length - MAX_ANOMALIES : 0;
    if (dots.length > MAX_ANOMALIES) {
      console.warn(
        `[dashboard] cpu.allAnomalies has ${dots.length} entries; trimming to last ${MAX_ANOMALIES}`,
      );
    }
    // Bucket-id → count. Each dot maps to one bucket via floor(ts/15s).
    const counts = new Map<number, number>();
    for (let i = start; i < dots.length; i++) {
      const ts = dots[i].ts;
      // Skip out-of-window dots — chart only shows tStart..tEnd.
      if (ts < tStart || ts > tEnd) continue;
      const bucket = Math.floor(ts / BUCKET_MS);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    // Materialise as Bar[] sorted by time. ~tens of buckets in the
    // visible window — sort cost is negligible.
    const out: Bar[] = [];
    const bucketIds = [...counts.keys()].sort((a, b) => a - b);
    for (const id of bucketIds) {
      out.push({
        start: id * BUCKET_MS,
        end: (id + 1) * BUCKET_MS,
        count: counts.get(id)!,
      });
    }
    return out;
  }, [cpu.allAnomalies, tStart, tEnd]);

  // 13. Requests: per-host rolling rate line + 1-min rolling rate as
  //     legend stat. Sources off `/live-agg`'s `requests_sum` /
  //     `requests_n` / `window_age_seconds` columns rather than
  //     smoothing raw `requests` events.
  //
  //     `requests_sum / window_age_seconds` is the per-host requests-
  //     per-second rate over the actual rolling-window contents at
  //     this row's tick. `window_age_seconds` (step 6+) is the
  //     elapsed wall-clock the rolling 1m window spans, capped at
  //     60 once warm. Dividing by the actual window age — not a
  //     hardcoded 60 — kills the warmup-ramp diagonal a fresh
  //     aggregator would otherwise show on this chart for its first
  //     60 seconds (the dashboard agent's option-2 fix from PR #25
  //     review). For long-running aggregators the divisor pins to
  //     60 and the formula is identical to the previous one.
  //
  //     **No per-tick EMA.** Earlier drafts ran `ema(α=0.25)` on
  //     `requests_sum` to mimic the raw path's per-event smoothing,
  //     but that's double-smoothing — `requests_sum` is *already* a
  //     1-minute moving average. The 5 Hz tick stream of a 1m
  //     rolling sum is naturally smooth (each tick differs from the
  //     previous by 200 ms of new samples minus 200 ms of expired
  //     samples). Plotting raw ticks reads cleanly without compound
  //     smoothing's added lag.
  const reqSeries = useMemo<ChartSeries[]>(() => {
    if (!aggSnapshot || aggSnapshot.length === 0) return [];
    if (enabledHosts.size === 0 || chartHostsSet.size === 0) {
      return [];
    }
    // Same filter-before-partition + downsample pattern as the CPU
    // section, with the same `chartHostsSet` (snapshot-throttled,
    // not WS-throttled — see the cpu memo above for why) so the
    // two memos run at the same cadence and the chart pipeline
    // stays in sync with the snapshot.
    const aggBucketMs = Math.max(
      200,
      Math.ceil(WINDOW_MS / TARGET_CHART_POINTS),
    );
    const filtered = aggSnapshot.filter((e) => {
      const h = e.get('host');
      return (
        typeof h === 'string' &&
        enabledHosts.has(h) &&
        chartHostsSet.has(h)
      );
    });
    if (filtered.length === 0) return [];
    const perHostRows = filtered
      .partitionBy('host')
      .aggregate(Sequence.every(`${aggBucketMs}ms`), {
        requests_sum: 'avg',
        requests_n: 'last',
        window_age_seconds: 'last',
      })
      .toMap((g) => g.toPoints());

    const out: ChartSeries[] = [];
    for (const host of hosts) {
      if (!enabledHosts.has(host)) continue;
      if (!chartHostsSet.has(host)) continue;
      const rows = perHostRows.get(host) ?? [];
      const points: ChartPoint[] = [];
      let latestRate: number | undefined;
      for (const r of rows) {
        // Push **one point per bucket-row** including gaps, with
        // `value: undefined` for the gate-failed rows. Pond's
        // `aggregate(Sequence.every(...))` emits one event per
        // bucket boundary regardless of bucket contents, so this
        // loop sees every visible-window bucket; pushing undefined
        // for the empty ones lets the canvas chart's gap detection
        // see real gaps instead of bridging two distant defined
        // points with a straight line. (Same pattern the cpu memo
        // uses for `smoothPoints` above.)
        if (
          typeof r.requests_sum !== 'number' ||
          (r.requests_n ?? 0) < 1
        ) {
          // requests_n < 1: the rolling window is empty for this
          // bucket — paint nothing rather than extrapolate a rate
          // from zero events.
          points.push({ ts: r.ts, value: undefined });
          continue;
        }
        const ageSec =
          typeof r.window_age_seconds === 'number'
            ? r.window_age_seconds
            : 60;
        // Cap divisor at >0 to avoid division by zero on the very
        // first frame after aggregator start (window_age_seconds
        // can be 0 if `firstEventTs == ts` exactly).
        const denom = Math.max(0.001, ageSec);
        const rate = r.requests_sum / denom;
        points.push({ ts: r.ts, value: rate });
        latestRate = rate;
      }
      out.push({
        name: host,
        color: hostColors[host],
        stat:
          latestRate != null ? `${latestRate.toFixed(0)}/s` : undefined,
        points,
      });
    }
    return out;
  }, [aggSnapshot, hosts, enabledHosts, chartHostsSet, hostColors]);

  // 14. Total req/sec across visible hosts — see
  //     `computeTotalReqPerSec` for the freshness-gate math.
  const totalReqPerSec = useMemo(
    () =>
      computeTotalReqPerSec(aggregate.latestPerHost, enabledHosts, tEnd),
    [aggregate.latestPerHost, enabledHosts, tEnd],
  );

  // 15. Logs section — most recent host-tick frames from the
  //     aggregate snapshot, newest first. Pre-step 9 the Logs
  //     section iterated raw events from `/live`; post-retirement it
  //     shows the actual aggregate-wire flow. Keeps the "demonstrate
  //     direct event iteration" affordance the section was always
  //     for. Filtered to enabled hosts so the toggle behaviour
  //     matches the rest of the dashboard.
  const recentTicks = useMemo<ReadonlyArray<HostTick>>(() => {
    if (!aggSnapshot || aggSnapshot.length === 0) return [];
    const out: HostTick[] = [];
    // Iterate the snapshot's tail; pond keeps events in chronological
    // order so iterating from `length-1` backwards gives newest-first.
    // Cap the scan at 200 to bound the work even at firehose; we only
    // need the top 20 after filtering.
    const maxScan = 200;
    const start = Math.max(0, aggSnapshot.length - maxScan);
    for (let i = aggSnapshot.length - 1; i >= start && out.length < 20; i--) {
      const e = aggSnapshot.at(i);
      if (!e) continue;
      const host = e.get('host');
      if (typeof host !== 'string' || !enabledHosts.has(host)) continue;
      // The aggregate wire row's columns map cleanly onto HostTick;
      // pond's typed accessors give the right shape per
      // `aggregateSchema`.
      out.push({
        ts: e.key().timestampMs(),
        host,
        cpu_avg: (e.get('cpu_avg') as number | null) ?? null,
        cpu_sd: (e.get('cpu_sd') as number | null) ?? null,
        cpu_n: e.get('cpu_n'),
        n_current: e.get('n_current'),
        anomalies_above:
          (e.get('anomalies_above') as ReadonlyArray<number> | undefined) ??
          [],
        anomalies_below:
          (e.get('anomalies_below') as ReadonlyArray<number> | undefined) ??
          [],
        requests_avg: (e.get('requests_avg') as number | null) ?? null,
        requests_sum: e.get('requests_sum'),
        requests_n: e.get('requests_n'),
        window_age_seconds: e.get('window_age_seconds'),
        cpu_min: (e.get('cpu_min') as number | null) ?? null,
        cpu_max: (e.get('cpu_max') as number | null) ?? null,
        current_avg: (e.get('current_avg') as number | null) ?? null,
        current_sd: (e.get('current_sd') as number | null) ?? null,
      });
    }
    return out;
  }, [aggSnapshot, enabledHosts]);

  // 16. Sparkline data for the HostTable. Per-host short window of
  //     `rankBy` values, used by the table's per-row sparkline cell
  //     to show a 12s-ish trend at a glance. Cap at the most recent
  //     ~60 ticks (`SPARKLINE_POINTS`) to bound canvas draw cost; at
  //     the default 200ms cadence that's a 12s window which is the
  //     minimum useful "is this host trending up/down" view.
  //
  //     Iterates the snapshot's tail backwards (newest-first) and
  //     bails when every visible host has filled its buffer or the
  //     scan budget is exhausted. The reverse output is then flipped
  //     to chronological order before storing — sparkline draws
  //     oldest-left, newest-right.
  const sparklineData = useMemo<
    ReadonlyMap<string, ReadonlyArray<number>>
  >(() => {
    if (!aggSnapshot || aggSnapshot.length === 0) return new Map();
    if (chartHostsSet.size === 0) return new Map();
    const SPARKLINE_POINTS = 60;
    // Reverse-order accumulator: each host gets up to N points
    // newest-first, then we reverse before returning.
    // Use `chartHostsSet` (snapshot-throttled) instead of
    // `aggregate.currentTopHosts` (5 fps) so this memo's deps
    // change at the snapshot cadence — see the chart memos for
    // the same reasoning.
    const reverseAcc = new Map<string, number[]>();
    for (const host of chartHostsSet) reverseAcc.set(host, []);
    // Bound the scan: most we ever need is N hosts × SPARKLINE_POINTS
    // events, plus slack for hosts with sparse data. 8× headroom.
    const maxScan = Math.min(
      aggSnapshot.length,
      chartHostsSet.size * SPARKLINE_POINTS * 8,
    );
    let filled = 0;
    const target = chartHostsSet.size;
    for (let i = aggSnapshot.length - 1; i >= aggSnapshot.length - maxScan; i--) {
      if (filled >= target) break;
      const e = aggSnapshot.at(i);
      if (!e) continue;
      const host = e.get('host');
      if (typeof host !== 'string') continue;
      const arr = reverseAcc.get(host);
      if (!arr || arr.length >= SPARKLINE_POINTS) continue;
      const v = e.get(rankBy);
      if (typeof v === 'number') {
        arr.push(v);
        if (arr.length >= SPARKLINE_POINTS) filled += 1;
      }
    }
    // Flip each per-host buffer so output is oldest→newest.
    const out = new Map<string, ReadonlyArray<number>>();
    for (const [host, arr] of reverseAcc) {
      if (arr.length === 0) continue;
      out.set(host, arr.slice().reverse());
    }
    return out;
  }, [aggSnapshot, chartHostsSet, rankBy]);

  return {
    totalEvents: totalEventsGlobal,
    totalRequests,
    eventsPerSec,
    evictedTotal,
    connectionStatus: aggregate.status,
    hosts,
    enabledHosts,
    hostColors,
    rollingCpu,
    trendCpu,
    cpuChartSeries: cpu.series,
    cpuBands: cpu.bands,
    cpuDots: cpu.dots,
    cpuAnomalyCount: cpu.allAnomalies.length,
    bars,
    reqSeries,
    totalReqPerSec,
    recentTicks,
    aggregate,
    sparklineData,
    tStart,
    tEnd,
  };
}

