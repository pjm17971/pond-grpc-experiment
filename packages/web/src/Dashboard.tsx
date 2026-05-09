import { useState } from 'react';
import { HOSTS } from '@pond-experiment/shared';
import { AggregateProbe } from './sections/AggregateProbe';
import { CpuSection } from './sections/CpuSection';
import { HostToggles } from './sections/HostToggles';
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
  // The set of hosts the user has explicitly disabled. Hosts default
  // to enabled; toggling adds/removes from this set. Hosts beyond
  // `api-1` start disabled so the chart stays readable while the
  // band/raw toggles are exercised — once a user toggles them on,
  // the entry stays out of `disabledHosts`.
  const [disabledHosts, setDisabledHosts] = useState<Set<string>>(
    () => new Set(HOSTS.slice(1)),
  );
  // Per-connection top-N preference. Drives the WS control message
  // the dashboard sends after open / on slider drag — see the
  // `topN` prop on `useRemoteAggregateSeries` and the server-side
  // `projectAppend`. Defaults to 5 — matches the chart's expected
  // legend density at firehose × 10 hosts. Setting to `null` would
  // ship every row (no filter); the slider clamps to [1, 15] in UI
  // and the parser also clamps server-side.
  const [topN, setTopN] = useState<number>(5);

  const data = useDashboardData({ disabledHosts, chartOpts, topN });

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
      <HostToggles
        hosts={data.hosts}
        hostColors={data.hostColors}
        enabledHosts={data.enabledHosts}
        currentTopHosts={data.aggregate.currentTopHosts}
        onToggle={onToggleHost}
        topN={topN}
        onTopNChange={setTopN}
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
