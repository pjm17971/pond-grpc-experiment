import { useState } from 'react';
import type { RankKey } from '@pond-experiment/shared';
import { AggregateProbe } from './sections/AggregateProbe';
import { CpuSection } from './sections/CpuSection';
import { HostTable } from './sections/HostTable';
import { LogsSection } from './sections/LogsSection';
import { PageSummary } from './sections/PageSummary';
import { RequestsSection } from './sections/RequestsSection';
import type { ChartOpts } from './useDashboardData';
import { useDashboardData } from './useDashboardData';

// Aggregate-stream URL derivation moved into `useDashboardData` so
// the single `useRemoteAggregateSeries` subscription owns both the
// connection and the connect-string. `Dashboard.tsx` is now a pure
// layout shell — no env reads, no URL plumbing.

/**
 * The dashboard is a layout shell. State lives here as a small set of
 * `useState`s; everything derived from the live series flows through
 * `useDashboardData`. Each section is a pure renderer of the data
 * hook's output plus whatever UI state it needs to round-trip.
 *
 *   useDashboardData   → opens WS to aggregator, mirrors its LiveSeries
 *   data hook output   → section components
 *
 * The M0 simulator-control sliders are gone — the aggregator owns
 * rate/host count now. Hosts populate via live discovery (pond's
 * `unique` aggregator over the `host` column), so the dashboard
 * adapts automatically to whatever subset the aggregator runs.
 */
export function Dashboard() {
  const [chartOpts, setChartOpts] = useState<ChartOpts>({
    // Anomaly bands (dashed σ edges + dots) are the headline overlay
    // — on by default. Distribution band (raw points) is off by
    // default; flip on to inspect within-tick spread of the
    // underlying samples without paying for the extra two filled
    // areas per host on first paint.
    showBands: true,
    showRaw: false,
    sigma: 2,
  });
  // The set of hosts the user has explicitly hidden from the chart.
  // The wire still ships them (server-side cut is by rank metric,
  // not user toggles); the chart memos drop them client-side via
  // this set. Defaults to empty: with the table showing only the
  // top-N (5 by default) and the chart matching, all visible hosts
  // are on by default.
  const [disabledHosts, setDisabledHosts] = useState<Set<string>>(
    () => new Set(),
  );
  // Per-connection top-N + rank metric. Both flow through to the
  // server as `{type:'set-top-n', n, by}` control messages on
  // dropdown change (no socket churn). Defaults: top-5 by 1m CPU
  // — the most-loaded hosts by baseline CPU, the canonical
  // monitoring view. Setting `topN: null` would ship every row
  // (no filter); the table dropdown only offers a discrete set
  // of values, server clamps to `[1, max(hostCount, 1000)]`.
  const [topN, setTopN] = useState<number>(5);
  const [rankBy, setRankBy] = useState<RankKey>('cpu_avg');

  const data = useDashboardData({ disabledHosts, chartOpts, topN, rankBy });

  const onToggleHost = (host: string) => {
    setDisabledHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  };

  return (
    <div className="dashboard">
      <PageSummary
        totalEvents={data.totalEvents}
        hostCount={data.hosts.length}
        eventsPerSec={data.eventsPerSec}
        evictedTotal={data.evictedTotal}
        connectionStatus={data.connectionStatus}
      />
      <HostTable
        currentTopHosts={data.aggregate.currentTopHosts}
        latestPerHost={data.aggregate.latestPerHost}
        hostColors={data.hostColors}
        enabledHosts={data.enabledHosts}
        onToggle={onToggleHost}
        topN={topN}
        onTopNChange={setTopN}
        rankBy={rankBy}
        onRankByChange={setRankBy}
        sparklineData={data.sparklineData}
      />
      <CpuSection
        data={data}
        chartOpts={chartOpts}
        onChartOptsChange={setChartOpts}
      />
      <RequestsSection data={data} />
      <LogsSection data={data} />
      <AggregateProbe aggregate={data.aggregate} />
    </div>
  );
}
