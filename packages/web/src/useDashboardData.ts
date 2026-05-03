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
import { useEffect, useMemo, useState } from 'react';
import {
  useCurrent,
  useEventRate,
  useTimeSeries,
  useWindow,
} from '@pond-ts/react';
import {
  Sequence,
  TimeSeries,
  type LiveSeries,
  type SeriesSchema,
} from 'pond-ts';
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
  schema,
} from '@pond-experiment/shared';
import { countAtSigma } from './anomalyInterpolation';
import {
  HIGH_CPU_THRESHOLD,
  PALETTE,
  WINDOW_MS,
} from './dashboardSchema';
import {
  useRemoteLiveSeries,
  type ConnectionStatus,
} from './useRemoteLiveSeries';
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

export type DashboardArgs = {
  disabledHosts: Set<string>;
  chartOpts: ChartOpts;
};

export type DashboardData = {
  liveSeries: LiveSeries<typeof schema>;

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

  // Logs section — raw windowed snapshot.
  timeSeries: TimeSeries<typeof schema> | null;

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
  // `showRaw` is in `chartOpts` but unused here today — the raw-
  // scatter overlay path is disabled (deferred to step 7 per WIRE.md).
  // Re-introduce when step 7's cpu_min/cpu_max repurpose lands.
  const { showBands, sigma } = chartOpts;

  // 1. LiveSeries — the single mutable buffer for ingest. Identical
  //    in shape to the M0 useLiveSeries call; the difference is the
  //    source of events: useRemoteLiveSeries opens a WebSocket to the
  //    aggregator, ingests the snapshot frame, then push()es each
  //    append frame. Same retention so client and aggregator drop the
  //    same rows at the same moment. The third tuple slot is the
  //    WS lifecycle status — surfaces in the page summary as a
  //    connection indicator.
  const [liveSeries, snapshot, connectionStatus] = useRemoteLiveSeries(
    WS_URL,
    {
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    },
    { throttle: 200 },
  );

  // 1b. Aggregate stream — `/live-agg` mirror with the wire's
  //     per-host tick aggregates (cpu_avg, cpu_sd, cpu_n). Step 3
  //     of M3.5 sources the CPU bands + smoothed line from this
  //     stream rather than from `timeSeries.baseline(...)` over raw
  //     events. Probe + counters keep their step-2 home.
  const aggregate = useRemoteAggregateSeries(AGG_WS_URL);
  const aggSnapshot = useWindow(aggregate.liveSeries, '5m', { throttle: 200 });
  // The σ-threshold list the snapshot frame's `thresholds` field
  // delivers. Step-4 anomaly-density interpolation keys off this —
  // see `anomalyInterpolation.ts`. Falls back to the default while
  // the first snapshot is in flight.
  const aggregateThresholds = aggregate.thresholds;

  // 2. Eviction counter — demonstrates `liveSeries.on('evict', cb)`.
  const [evictedTotal, setEvictedTotal] = useState(0);
  useEffect(() => {
    return liveSeries.on('evict', (events) => {
      setEvictedTotal((n) => n + events.length);
    });
  }, [liveSeries]);

  // 3. Throttled 5-min windowed snapshot. `useWindow` owns the live
  //    view subscription; what we get back is an immutable TimeSeries
  //    we can chain transforms on without worrying about live mutation.
  const timeSeries = useWindow(liveSeries, '5m', { throttle: 200 });

  // 4. Host model: discovered live from the data via the `unique`
  //    aggregator over the `host` column. Filtered through HOSTS so
  //    the canonical declaration order drives palette assignment —
  //    a host's color stays the same whatever order the data
  //    arrives in. Hosts not in HOSTS won't render until added
  //    there (M2's real producer may force this).
  const { host: discoveredHosts } = useCurrent(
    liveSeries,
    { host: 'unique' },
    { throttle: 500 },
  );
  const hosts = useMemo(() => {
    if (!discoveredHosts || discoveredHosts.length === 0) return [];
    const seen = new Set(discoveredHosts);
    return HOSTS.filter((h) => seen.has(h));
  }, [discoveredHosts]);
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

  // 5. Whole-source rollups (computed live, not from the window).
  //    `useCurrent` is sugar for `useSnapshot(src).tail(t).reduce(map)`.
  //    Event rate uses 0.11.7's `useEventRate` — closes the M1
  //    `useCurrent({ cpu: 'count' }).cpu / 60` boilerplate.
  const { requests: totalRequests } = useCurrent(
    liveSeries,
    { requests: 'sum' },
    { throttle: 500 },
  );
  const eventsPerSec = useEventRate(liveSeries, '1m');
  const { cpu: rollingCpu } = useCurrent(
    liveSeries,
    { cpu: 'avg' },
    { tail: '1m', throttle: 200 },
  );

  // 6. Time axis pinned to the latest event with a fixed back-window.
  const tEnd = timeSeries?.last()?.key().timestampMs();
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
    const series: ChartSeries[] = [];
    const bands: ChartBand[] = [];
    const dots: ChartDots[] = [];
    const allAnomalies: ChartPoint[] = [];
    if (!aggSnapshot) {
      return { series, bands, dots, allAnomalies };
    }

    // Per-host rows of the windowed `LiveSeries<AggregateSchema>`,
    // one row per 200ms tick boundary.
    const aggPerHostRows = aggSnapshot
      .partitionBy('host')
      .toMap((g) => g.toPoints());

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

      const upper: ChartPoint[] = [];
      const lower: ChartPoint[] = [];
      const smoothPoints: ChartPoint[] = [];
      const anomalyDots: ChartPoint[] = [];
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
      const aggRows = aggPerHostRows.get(host) ?? [];
      for (const r of aggRows) {
        const gated = (r.cpu_n ?? 0) >= MIN_SAMPLES;
        if (gated && r.cpu_avg != null) {
          smoothPoints.push({ ts: r.ts, value: r.cpu_avg });
          lastAvg = r.cpu_avg;
          if (r.cpu_sd != null) {
            const upperEdge = r.cpu_avg + sigma * r.cpu_sd;
            const lowerEdge = r.cpu_avg - sigma * r.cpu_sd;
            upper.push({ ts: r.ts, value: upperEdge });
            lower.push({ ts: r.ts, value: lowerEdge });
            // Per-tick anomaly density at the user's σ — plot a dot
            // at the band edge when the interpolated count is ≥ 1.
            // Pond's `kind: 'array'` columns are typed
            // `ReadonlyArray<ScalarValue>` (number|string|boolean) at
            // the schema level; the wire contract guarantees number
            // arrays, so the cast is safe here.
            const aAbove = (r.anomalies_above as ReadonlyArray<number>) ?? [];
            const aboveCount = countAtSigma(aAbove, sigma, thresholds);
            if (aboveCount >= 1) {
              anomalyDots.push({ ts: r.ts, value: upperEdge });
            }
            const aBelow = (r.anomalies_below as ReadonlyArray<number>) ?? [];
            const belowCount = countAtSigma(aBelow, sigma, thresholds);
            if (belowCount >= 1) {
              anomalyDots.push({ ts: r.ts, value: lowerEdge });
            }
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
      }

      // The raw-samples scatter overlay (`showRaw`) is deferred — see
      // WIRE.md: with aggregate-driven bands/smoothed-line on a 200ms
      // tick clock, mixing in raw events at ~10ms cadence would
      // introduce sparse rows in the chart's merged-by-ts data and
      // break `connectNulls={false}` on the smoothed line + bands.
      // The dashboard agent's repurpose-as-show-min/max plan lands in
      // step 7 once `cpu_min`/`cpu_max` are on the wire. The toggle
      // stays in UI but is a no-op until then.

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
    }

    return { series, bands, dots, allAnomalies };
    // `showRaw` and `timeSeries` are intentionally NOT deps: the
    // CPU section is fully aggregate-driven now (step 4 retired the
    // raw baseline pipeline). Re-introduce when step 7's
    // cpu_min/cpu_max repurpose brings the raw overlay back.
  }, [
    aggSnapshot,
    aggregateThresholds,
    hosts,
    enabledHosts,
    hostColors,
    showBands,
    sigma,
  ]);

  // 8. EMA-smoothed trend across all hosts (summary stat only).
  const trendCpu = useMemo(() => {
    if (!timeSeries || timeSeries.length === 0) return undefined;
    return timeSeries
      .smooth('cpu', 'ema', { alpha: 0.3, output: 'cpuTrend' })
      .last()
      ?.get('cpuTrend');
  }, [timeSeries]);

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

  // 11. High-CPU filter: events from enabled hosts where cpu > threshold.
  //     Used for the "Alerts" stat AND as the source for the threshold-mode
  //     bar chart bucketing. Filtering on `timeSeries` (a snapshot) so the
  //     enabledHosts set can change without rebuilding a LiveView.
  const highCpuFiltered = useMemo(() => {
    if (!timeSeries) return null;
    return timeSeries.filter(
      (e) =>
        enabledHosts.has(e.get('host')) && e.get('cpu') > HIGH_CPU_THRESHOLD,
    );
  }, [timeSeries, enabledHosts]);

  // 12. Bar chart buckets: 15-second bins of either anomalies (band mode)
  //     or alerts (threshold mode). Both paths end in `aggregate(...)
  //     → iterate buckets → push Bar`.
  const bars: Bar[] = useMemo(() => {
    if (tStart == null || tEnd == null) return [];

    if (showBands) {
      // Band mode: round-trip the flat anomaly points back into a tiny
      // TimeSeries via `fromPoints` so we can use pond's bucketing.
      if (cpu.allAnomalies.length === 0) return [];
      const anomalyTs = TimeSeries.fromPoints(cpu.allAnomalies, {
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

    // Threshold mode: aggregate the live filter directly.
    if (!highCpuFiltered || highCpuFiltered.length === 0) return [];
    return aggregateToBars(
      highCpuFiltered.aggregate(Sequence.every('15s'), { cpu: 'count' }),
      'cpu',
      tStart,
      tEnd,
    );
  }, [showBands, cpu.allAnomalies, highCpuFiltered, tStart, tEnd]);

  // 13. Requests: per-host smoothed lines + 1-min rolling avg as legend stat.
  //     Same partition pattern as CPU; two `partitionBy.toMap(...)` calls
  //     produce the per-host smoothed points and the per-host scalar avg.
  const reqSeries = useMemo<ChartSeries[]>(() => {
    if (!timeSeries) return [];
    // eps is the measured event rate (events/sec). Pre-1m, the rolling
    // count is undefined; fall back to 0 so the chart renders flat
    // (rather than NaN) during the warm-up.
    const eps = eventsPerSec ?? 0;
    const perHostSmooth = timeSeries
      .partitionBy('host')
      .smooth('requests', 'ema', { alpha: 0.25 })
      .toMap((g) => g.slice(12).toPoints());
    const perHostAvg = timeSeries
      .partitionBy('host')
      .toMap((g) => g.tail('1m').reduce({ requests: 'avg' }).requests);

    const out: ChartSeries[] = [];
    for (const host of hosts) {
      if (!enabledHosts.has(host)) continue;
      const rows = perHostSmooth.get(host) ?? [];
      const rollingAvg = perHostAvg.get(host);
      out.push({
        name: host,
        color: hostColors[host],
        stat:
          rollingAvg != null
            ? `${(rollingAvg * eps).toFixed(0)}/s`
            : undefined,
        points: rows.flatMap((r) =>
          r.requests == null
            ? []
            : [{ ts: r.ts, value: r.requests * eps }],
        ),
      });
    }
    return out;
  }, [timeSeries, hosts, enabledHosts, hostColors, eventsPerSec]);

  // 14. Total req/sec across visible hosts — sum of the latest point per series.
  const totalReqPerSec = reqSeries.reduce((sum, s) => {
    const last = s.points[s.points.length - 1];
    return sum + (last?.value ?? 0);
  }, 0);

  return {
    liveSeries,
    totalEvents: snapshot?.length ?? 0,
    totalRequests,
    eventsPerSec,
    evictedTotal,
    connectionStatus,
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
    timeSeries,
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
