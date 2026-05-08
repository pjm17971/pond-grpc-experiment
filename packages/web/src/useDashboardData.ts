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
import { useTimeSeries, useWindow } from '@pond-ts/react';
import { Sequence, TimeSeries, type SeriesSchema } from 'pond-ts';

/**
 * Target points per chart series. The CPU/Requests charts are ~420px
 * wide; rendering more than ~1 point per pixel is wasted SVG-node
 * churn that React+Recharts has to diff every frame. With a 5-min
 * window of 5 fps/host ticks (1500 raw rows), TARGET_CHART_POINTS=500
 * gives ~3× downsample with no visible loss. See M3.5 friction note
 * "Recharts as the dashboard's render bottleneck".
 */
const TARGET_CHART_POINTS = 500;
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
  baselineSchema,
  type HostTick,
} from '@pond-experiment/shared';
import { countAtSigma } from './anomalyInterpolation';
import {
  HIGH_CPU_THRESHOLD,
  PALETTE,
  WINDOW_MS,
} from './dashboardSchema';
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
  /** Toggle between threshold mode (off) and anomaly mode (on). */
  showBands: boolean;
  /** Overlay the unsmoothed per-host samples behind the smoothed line. */
  showRaw: boolean;
  /** Band width in standard deviations. */
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
  cpuAlertCount: number;
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

  // Shared time axis for both the CPU and Requests charts.
  tStart: number | undefined;
  tEnd: number | undefined;
};

export function useDashboardData(args: DashboardArgs): DashboardData {
  const { disabledHosts, chartOpts } = args;
  // `showRaw` controls the per-tick min/max envelope overlay on the
  // CPU chart (step 7's repurpose of the legacy raw-samples toggle —
  // WIRE.md "show min/max" pattern, sourced from `cpu_min`/`cpu_max`
  // on the aggregate stream). When on, each enabled host's chart gets
  // two extra thin lines tracing the per-tick CPU extrema.
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
  const aggregate = useRemoteAggregateSeries(AGG_WS_URL);
  const aggSnapshot = useWindow(aggregate.liveSeries, '5m', { throttle: 200 });
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

  // 5. Rolling 1m CPU avg across enabled hosts, sourced from the
  //    aggregate stream's `latestPerHost` map. See
  //    `computeWeightedRollingCpu` for the weighting math.
  const rollingCpu = useMemo(
    () => computeWeightedRollingCpu(aggregate.latestPerHost, enabledHosts),
    [aggregate.latestPerHost, enabledHosts],
  );

  // 6. Time axis pinned to the latest aggregate tick with a fixed
  //    back-window. Single source of truth — every chart path now
  //    sources from `/live-agg`.
  const tEnd = aggSnapshot?.last()?.key().timestampMs();
  const tStart = tEnd != null ? tEnd - WINDOW_MS : undefined;

  // 7. CPU section — fully aggregate-driven now. Bands + smoothed
  //    line + anomaly dots all source from `/live-agg`'s tick rows;
  //    the raw `timeSeries.baseline(...)` pipeline this section used
  //    to run is gone (step 4 retires it).
  //
  //    Anomaly dots are now per-tick density dots on the band edges
  //    (per WIRE.md), not per-event red dots on raw values. For each
  //    enabled host's rows in the aggregate windowed snapshot:
  //      - render smoothed line + ±σ band from cpu_avg/cpu_sd (gated
  //        on cpu_n >= 30, equivalent to the previous minSamples)
  //      - interpolate the σ-bucketed `anomalies_above[]` /
  //        `anomalies_below[]` arrays at the user's slider value, and
  //        render a dot at the band edge when the interpolated count
  //        is ≥ 1.
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

    // **Filter to enabled hosts before partitioning** — at 80-host
    // firehose loads the full partition would allocate ~120k row
    // objects per render to use ~1.5k of them. Filtering first scopes
    // the allocation to the hosts we'll actually iterate. The
    // partitioned series is then reused for both the full-res
    // anomaly scan (sparse signals, must see every tick) and the
    // downsampled line/band data — `partitionBy` returns a structural
    // wrapper, so the second consumer is cheap.
    const filtered = aggSnapshot.filter((e) => {
      const h = e.get('host');
      return typeof h === 'string' && enabledHosts.has(h);
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
      const color = hostColors[host];

      // ── Pass 1: per-tick anomaly dots (full resolution). Anomalies
      //    are sparse single-tick signals; plotting them at downsampled
      //    bucket boundaries would smear them and risk dropping them
      //    inside an all-zero bucket. Iterate every tick and emit a
      //    dot whenever the σ-bucketed count crosses 1.
      const anomalyDots: ChartPoint[] = [];
      const fullRows = fullResPerHost.get(host) ?? [];
      for (const r of fullRows) {
        if (r.cpu_avg == null || r.cpu_sd == null) continue;
        const upperEdge = r.cpu_avg + sigma * r.cpu_sd;
        const lowerEdge = r.cpu_avg - sigma * r.cpu_sd;
        // `kind: 'array'` columns are typed `ReadonlyArray<ScalarValue>`
        // (number|string|boolean) at the schema level; the wire contract
        // guarantees number arrays, so the cast is safe.
        const aAbove = (r.anomalies_above as ReadonlyArray<number>) ?? [];
        if (countAtSigma(aAbove, sigma, thresholds) >= 1) {
          anomalyDots.push({ ts: r.ts, value: upperEdge });
        }
        const aBelow = (r.anomalies_below as ReadonlyArray<number>) ?? [];
        if (countAtSigma(aBelow, sigma, thresholds) >= 1) {
          anomalyDots.push({ ts: r.ts, value: lowerEdge });
        }
      }

      // ── Pass 2: line/band points from the downsampled bucket rows.
      const upper: ChartPoint[] = [];
      const lower: ChartPoint[] = [];
      const smoothPoints: ChartPoint[] = [];
      // Step 7 — per-tick CPU min/max envelope (the toggle's
      // semantic). Pond's `min`/`max` reducers preserve the bucket's
      // extremum so a single-tick spike survives the downsample.
      const minPoints: ChartPoint[] = [];
      const maxPoints: ChartPoint[] = [];
      let lastAvg: number | undefined;

      // `cpu_n >= MIN_SAMPLES` is the gate-on-render mask, equivalent
      // to the raw side's `baseline(..., { minSamples: 30 })`. Under
      // bucket-count `cpu_n` semantics (the library agent's correction
      // during the 0.13 review), `cpu_n` is already the rolling-1m
      // sample count for that bucket — so the gate is just a per-row
      // check, no client-side sum across rows needed. Kills the
      // staircase artefact when the producer pauses and the rolling
      // window has too few samples to trust mean/sd.
      const MIN_SAMPLES = 30;
      const aggRows = downsampledPerHost.get(host) ?? [];
      for (const r of aggRows) {
        const gated = (r.cpu_n ?? 0) >= MIN_SAMPLES;
        if (gated && r.cpu_avg != null) {
          smoothPoints.push({ ts: r.ts, value: r.cpu_avg });
          lastAvg = r.cpu_avg;
          if (r.cpu_sd != null) {
            upper.push({ ts: r.ts, value: r.cpu_avg + sigma * r.cpu_sd });
            lower.push({ ts: r.ts, value: r.cpu_avg - sigma * r.cpu_sd });
          } else {
            upper.push({ ts: r.ts, value: undefined });
            lower.push({ ts: r.ts, value: undefined });
          }
        } else {
          // Below the gate or stats absent — render a gap (the
          // dashboard agent's render-gap convention from WIRE.md).
          smoothPoints.push({ ts: r.ts, value: undefined });
          upper.push({ ts: r.ts, value: undefined });
          lower.push({ ts: r.ts, value: undefined });
        }
        // Min/max envelope tracks cpu_min/cpu_max on every row,
        // independent of the cpu_n MIN_SAMPLES gate. The envelope is
        // a direct readout of the bucket's spike extrema (pond's
        // `min`/`max` reducers — see the aggregate call above). Gate
        // only on slice content (`n_current >= 1`); empty slices
        // produce null on the wire and the `'min'`/`'max'` reducer
        // falls back to undefined, which renders as a gap.
        if (showRaw) {
          const sliceFilled = (r.n_current ?? 0) >= 1;
          minPoints.push({
            ts: r.ts,
            value:
              sliceFilled && typeof r.cpu_min === 'number'
                ? r.cpu_min
                : undefined,
          });
          maxPoints.push({
            ts: r.ts,
            value:
              sliceFilled && typeof r.cpu_max === 'number'
                ? r.cpu_max
                : undefined,
          });
        }
      }

      series.push({
        name: host,
        color,
        stat:
          lastAvg != null ? `${(lastAvg * 100).toFixed(0)}%` : undefined,
        points: smoothPoints,
      });
      if (showBands && upper.length >= 2) {
        bands.push({ name: host, color, upper, lower });
        if (anomalyDots.length > 0) {
          dots.push({ name: host, color: '#e23b3b', points: anomalyDots });
          allAnomalies.push(...anomalyDots);
        }
      }
      if (showRaw && (minPoints.length >= 2 || maxPoints.length >= 2)) {
        // Two thin host-coloured lines tracing the 200ms-slice
        // extrema. Hidden from the legend (the host's smoothed line
        // already represents it; this is overlay context). Slightly
        // transparent + dashed so the smoothed line stays the
        // primary visual.
        series.push({
          name: `${host} max`,
          color,
          points: maxPoints,
          dashed: true,
          width: 1,
          opacity: 0.55,
          hideFromLegend: true,
        });
        series.push({
          name: `${host} min`,
          color,
          points: minPoints,
          dashed: true,
          width: 1,
          opacity: 0.55,
          hideFromLegend: true,
        });
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
    hostColors,
    showBands,
    showRaw,
    sigma,
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

  // 9. Static 70%-threshold line, mounted via `useTimeSeries`. Two rows
  //    spanning ±1h around mount; the chart clips it to the visible
  //    window. Demonstrates the static-data path.
  const baselineInput = useMemo(() => {
    const now = Date.now();
    const rows: [number, number][] = [
      [now - 3_600_000, HIGH_CPU_THRESHOLD],
      [now + 3_600_000, HIGH_CPU_THRESHOLD],
    ];
    return { name: 'threshold', schema: baselineSchema, rows };
  }, []);
  const baselineTs = useTimeSeries(baselineInput);
  const thresholdValue = baselineTs?.first()?.get('cpu') as
    | number
    | undefined;
  const thresholdPoints =
    thresholdValue != null && tStart != null && tEnd != null
      ? [
          { ts: tStart, value: thresholdValue },
          { ts: tEnd, value: thresholdValue },
        ]
      : [];

  // 10. Final chart series. In threshold mode we append the dashed red
  //     reference line; in anomaly mode the bands + dots speak for it.
  const cpuChartSeries: ChartSeries[] = showBands
    ? cpu.series
    : [
        ...cpu.series,
        {
          name: 'threshold',
          color: '#e23b3b',
          points: thresholdPoints,
          dashed: true,
        },
      ];

  // 11. High-CPU filter: aggregate-stream rows from enabled hosts where
  //     `cpu_avg` exceeds the static 70% threshold. Used for the
  //     "Alerts" stat AND as the source for the threshold-mode bar
  //     chart bucketing. Pre-step 9 this filtered raw events over the
  //     `/live` snapshot; post-retirement it filters per-tick host
  //     aggregates. The unit changes — pre-step 9 each match was one
  //     raw event over threshold, now each match is one (host, tick)
  //     pair where the host's 1m baseline is over threshold — so the
  //     count semantics shift from "how many over-threshold events"
  //     to "how many over-threshold host-ticks." Same shape, denser
  //     data: 80 hosts × 5 fps = 400 potential alerts/sec on the
  //     aggregate stream regardless of underlying event rate. The
  //     dashboard label stays "Alerts" because the visual story
  //     ("how often is something hot?") is unchanged.
  const highCpuFiltered = useMemo(() => {
    if (!aggSnapshot) return null;
    return aggSnapshot.filter((e) => {
      const h = e.get('host');
      const cpu = e.get('cpu_avg');
      return (
        typeof h === 'string' &&
        enabledHosts.has(h) &&
        typeof cpu === 'number' &&
        cpu > HIGH_CPU_THRESHOLD
      );
    });
  }, [aggSnapshot, enabledHosts]);

  // 12. Bar chart buckets: 15-second bins of either anomalies (band mode)
  //     or alerts (threshold mode). Both paths end in `aggregate(...)
  //     → iterate buckets → push Bar`.
  const bars: Bar[] = useMemo(() => {
    if (tStart == null || tEnd == null) return [];

    if (showBands) {
      // Band mode: round-trip the flat anomaly points back into a tiny
      // TimeSeries via `fromPoints` so we can use pond's bucketing.
      //
      // **Sort first.** `cpu.allAnomalies` is built by appending each
      // host's dots in chronological order, but across hosts the
      // concatenated array isn't sorted — host A's dots at ts T1, T2
      // come before host B's at T1', T2' even when T1' < T2.
      // `TimeSeries.fromPoints` requires non-decreasing timestamps
      // and throws "row N is out of order" otherwise. Pre-step-6 the
      // simulator's IID noise rarely produced anomalies on multiple
      // hosts in the same window, so the cross-host overlap was
      // exotic; step 6's burst dynamics make it common (an active
      // burst on host A and host B at the same tick produces
      // interleaved timestamps after concatenation).
      //
      // **Cap first.** The natural ceiling on `cpu.allAnomalies` is
      // 5m × 5 fps × N_hosts × 2 dots ≈ 24k entries even at maximum
      // anomaly density. If we're handed an array meaningfully
      // larger than that, something upstream is broken (LiveSeries
      // not enforcing retention because React is in a render-error
      // retry loop, etc.) and we should refuse rather than feed
      // megabytes into `fromPoints` and OOM the tab. Slice to the
      // most recent `MAX_ANOMALIES` entries — the bar chart only
      // shows the visible-time-axis window anyway.
      if (cpu.allAnomalies.length === 0) return [];
      const MAX_ANOMALIES = 50_000;
      const trimmed =
        cpu.allAnomalies.length > MAX_ANOMALIES
          ? cpu.allAnomalies.slice(-MAX_ANOMALIES)
          : cpu.allAnomalies;
      if (cpu.allAnomalies.length > MAX_ANOMALIES) {
        // Loud signal in dev — if this fires we want to know.
        console.warn(
          `[dashboard] cpu.allAnomalies has ${cpu.allAnomalies.length} entries; trimming to last ${MAX_ANOMALIES}`,
        );
      }
      const sortedAnomalies = [...trimmed].sort((a, b) => a.ts - b.ts);
      const anomalyTs = TimeSeries.fromPoints(sortedAnomalies, {
        name: 'anomalies',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number' },
        ] as const,
      });
      return aggregateToBars(
        anomalyTs.aggregate(Sequence.every('15s'), { value: 'count' }),
        'value',
        tStart,
        tEnd,
      );
    }

    // Threshold mode: aggregate the live filter directly. Counts
    // (host, tick) pairs over threshold per 15s bucket — see the
    // semantic note on `highCpuFiltered` above.
    if (!highCpuFiltered || highCpuFiltered.length === 0) return [];
    return aggregateToBars(
      highCpuFiltered.aggregate(Sequence.every('15s'), { cpu_avg: 'count' }),
      'cpu_avg',
      tStart,
      tEnd,
    );
  }, [showBands, cpu.allAnomalies, highCpuFiltered, tStart, tEnd]);

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
    // Same filter-before-partition + downsample pattern as the CPU
    // section. `requests_sum` is already a 1-min rolling sum, so
    // averaging it across the bucket gives the natural plot value;
    // `requests_n` and `window_age_seconds` are gates / divisors,
    // sample at the bucket's terminal tick. No spike-preserving
    // signal here so all reducers are smooth-friendly.
    const aggBucketMs = Math.max(
      200,
      Math.ceil(WINDOW_MS / TARGET_CHART_POINTS),
    );
    const filtered = aggSnapshot.filter((e) => {
      const h = e.get('host');
      return typeof h === 'string' && enabledHosts.has(h);
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
      const rows = perHostRows.get(host) ?? [];
      const points: ChartPoint[] = [];
      let latestRate: number | undefined;
      for (const r of rows) {
        if (typeof r.requests_sum !== 'number') continue;
        // Need at least one event so requests_sum reflects real
        // data and we don't paint extrapolated rates from an empty
        // rolling window.
        if ((r.requests_n ?? 0) < 1) continue;
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
  }, [aggSnapshot, hosts, enabledHosts, hostColors]);

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
      });
    }
    return out;
  }, [aggSnapshot, enabledHosts]);

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
    cpuChartSeries,
    cpuBands: cpu.bands,
    cpuDots: cpu.dots,
    cpuAnomalyCount: cpu.allAnomalies.length,
    cpuAlertCount: highCpuFiltered?.length ?? 0,
    bars,
    reqSeries,
    totalReqPerSec,
    recentTicks,
    aggregate,
    tStart,
    tEnd,
  };
}

/**
 * Helper: turn a bucketed TimeSeries (output of `aggregate(seq,
 * { col: 'count' })`) into the bar chart's flat `Bar[]` shape, clipped
 * to the visible time axis.
 */
function aggregateToBars(
  buckets: TimeSeries<SeriesSchema>,
  col: string,
  tStart: number,
  tEnd: number,
): Bar[] {
  const out: Bar[] = [];
  for (const e of buckets) {
    const start = e.key().begin();
    const end = e.key().end();
    if (end < tStart || start > tEnd) continue;
    // Bucket events are dynamically typed (`SeriesSchema`); the count
    // reducer always emits `number | undefined`.
    out.push({
      start,
      end,
      count: ((e.data() as Record<string, unknown>)[col] as number | undefined) ?? 0,
    });
  }
  return out;
}
