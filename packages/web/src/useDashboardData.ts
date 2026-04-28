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
import { HOSTS, baselineSchema, schema } from '@pond-experiment/shared';
import {
  HIGH_CPU_THRESHOLD,
  PALETTE,
  WINDOW_MS,
} from './dashboardSchema';
import { useRemoteLiveSeries } from './useRemoteLiveSeries';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/live';

export type ChartOpts = {
  /** Toggle between threshold mode (off) and anomaly mode (on). */
  showBands: boolean;
  /** Overlay the unsmoothed per-host samples behind the smoothed line. */
  showRaw: boolean;
  /** Band width in standard deviations. */
  sigma: number;
};

export type DashboardArgs = {
  hostCount: number;
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

  // Shared time axis for both the CPU and Requests charts.
  tStart: number | undefined;
  tEnd: number | undefined;
};

export function useDashboardData(args: DashboardArgs): DashboardData {
  const { hostCount, disabledHosts, chartOpts } = args;
  const { showBands, showRaw, sigma } = chartOpts;

  // 1. LiveSeries — the single mutable buffer for ingest. Identical
  //    in shape to the M0 useLiveSeries call; the difference is the
  //    source of events: useRemoteLiveSeries opens a WebSocket to the
  //    aggregator, ingests the snapshot frame, then push()es each
  //    append frame. Same retention so client and aggregator drop the
  //    same rows at the same moment.
  const [liveSeries, snapshot] = useRemoteLiveSeries(
    WS_URL,
    {
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    },
    { throttle: 200 },
  );

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

  // 4. Host model: active slice (from the simulator's hostCount) and
  //    the user-toggled enabled set.
  const hosts = useMemo(
    () => HOSTS.slice(0, hostCount) as readonly string[],
    [hostCount],
  );
  const enabledHosts = useMemo(() => {
    const set = new Set<string>();
    for (const h of hosts) if (!disabledHosts.has(h)) set.add(h);
    return set;
  }, [hosts, disabledHosts]);
  const hostColors = useMemo(() => {
    const map: Record<string, string> = {};
    hosts.forEach((h, i) => (map[h] = PALETTE[i % PALETTE.length]));
    return map;
  }, [hosts]);

  // 5. Whole-source rollups (computed live, not from the window).
  //    `useCurrent` is sugar for `useSnapshot(src).tail(t).reduce(map)`.
  //    Event rate is the trailing 1-minute count of any non-null
  //    column divided by 60. Picking `cpu` is arbitrary — pond's
  //    `count` reducer needs a column to count non-null values of.
  //    A column-free `count` would feel cleaner (friction note).
  const { requests: totalRequests } = useCurrent(
    liveSeries,
    { requests: 'sum' },
    { throttle: 500 },
  );
  const { cpu: lastMinuteCount } = useCurrent(
    liveSeries,
    { cpu: 'count' },
    { tail: '1m', throttle: 500 },
  );
  const eventsPerSec =
    lastMinuteCount != null ? lastMinuteCount / 60 : undefined;
  const { cpu: rollingCpu } = useCurrent(
    liveSeries,
    { cpu: 'avg' },
    { tail: '1m', throttle: 200 },
  );

  // 6. Time axis pinned to the latest event with a fixed back-window.
  const tEnd = timeSeries?.last()?.key().timestampMs();
  const tStart = tEnd != null ? tEnd - WINDOW_MS : undefined;

  // 7. CPU section — per-host bands, smoothed lines, anomaly dots.
  //    The pond pipeline:
  //      partitionBy('host')                       ← scope per-host
  //        .baseline('cpu', { window, sigma })     ← single rolling pass,
  //                                                  appends avg/sd/upper/lower
  //        .toMap(g => g.toPoints())               ← Map<host, wide rows>
  //
  //    `toMap(fn)` runs `fn` per partition and returns the result map
  //    directly — no `.collect()` round-trip, no extra `groupBy` pass.
  //    Each host's rows already have every column we need; the local
  //    loop just splits them into the chart's per-purpose arrays.
  const cpu = useMemo(() => {
    const series: ChartSeries[] = [];
    const bands: ChartBand[] = [];
    const dots: ChartDots[] = [];
    const allAnomalies: ChartPoint[] = [];
    if (!timeSeries) return { series, bands, dots, allAnomalies };

    // `minSamples` (0.11.2) gates baseline output: rows whose 1-min
    // window has fewer than 30 source events emit `undefined` for
    // avg/sd/upper/lower. That kills the staircase artefact during
    // throttled-tab periods (sparse events, inflated rolling avg from a
    // tiny sample) and the post-resume warm-up.
    //
    // Note: this counts source events directly. We deliberately don't
    // run `materialize` upstream — that would inflate the window's
    // event count with synthetic empty cells and the gate would never
    // fire. Source events in / source events counted out.
    const perHostRows = timeSeries
      .partitionBy('host')
      .baseline('cpu', { window: '1m', sigma, minSamples: 30 })
      .toMap((g) => g.toPoints());

    for (const host of hosts) {
      if (!enabledHosts.has(host)) continue;
      const rows = perHostRows.get(host);
      if (!rows) continue;
      const color = hostColors[host];

      const upper: ChartPoint[] = [];
      const lower: ChartPoint[] = [];
      const anomalies: ChartPoint[] = [];
      const rawPoints: ChartPoint[] = [];
      const smoothPoints: ChartPoint[] = [];
      let lastAvg: number | undefined;

      // Library `minSamples` (above) already nulls out avg/sd/upper/
      // lower wherever the window is too sparse. Pushing every row —
      // including ones whose rolling outputs are undefined — keeps
      // those gaps visible in the chart via `connectNulls={false}`.
      for (const r of rows) {
        rawPoints.push({ ts: r.ts, value: r.cpu });
        smoothPoints.push({ ts: r.ts, value: r.avg });
        if (r.avg != null) lastAvg = r.avg;
        upper.push({ ts: r.ts, value: r.upper });
        lower.push({ ts: r.ts, value: r.lower });
        if (
          r.cpu != null &&
          r.upper != null &&
          r.lower != null &&
          (r.cpu > r.upper || r.cpu < r.lower)
        ) {
          anomalies.push({ ts: r.ts, value: r.cpu });
        }
      }

      if (showRaw) {
        series.push({
          name: `${host} raw`,
          color,
          width: 0.75,
          opacity: 0.35,
          hideFromLegend: true,
          points: rawPoints,
        });
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
        if (anomalies.length > 0) {
          dots.push({ name: host, color: '#e23b3b', points: anomalies });
          allAnomalies.push(...anomalies);
        }
      }
    }

    return { series, bands, dots, allAnomalies };
  }, [timeSeries, hosts, enabledHosts, hostColors, showBands, showRaw, sigma]);

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
