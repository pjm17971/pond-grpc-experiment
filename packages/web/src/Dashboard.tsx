import { useState } from 'react';
import { CpuSection } from './sections/CpuSection';
import { HostToggles } from './sections/HostToggles';
import { LogsSection } from './sections/LogsSection';
import { PageSummary } from './sections/PageSummary';
import { RequestsSection } from './sections/RequestsSection';
import type { ChartOpts } from './useDashboardData';
import { useDashboardData } from './useDashboardData';

/**
 * The dashboard is a layout shell. State lives here as a small set of
 * `useState`s; everything derived from the live series flows through
 * `useDashboardData`. Each section is a pure renderer of the data
 * hook's output plus whatever UI state it needs to round-trip.
 *
 *   useDashboardData   → opens WS to aggregator, mirrors its LiveSeries
 *   data hook output   → section components
 *
 * The simulator-control sliders that owned `eventsPerSec`/`hostCount`/
 * `variability` in M0 are gone — the aggregator owns those now.
 * `eventsPerSec` is now measured from the data itself; `hostCount` is
 * pinned to the aggregator's default until M2's HTTP control endpoint
 * lets us recover dynamic discovery.
 */
const AGGREGATOR_HOST_COUNT = 4;

export function Dashboard() {
  const [chartOpts, setChartOpts] = useState<ChartOpts>({
    showBands: true,
    // Show raw samples by default — the most direct visual signal of
    // "data is flowing right now". When the source pauses, the raw line
    // breaks immediately at the next undefined cell; the smoothed line
    // can lag because its rolling window still contains pre-pause data.
    showRaw: true,
    sigma: 2,
  });
  // The set of hosts the user has explicitly disabled. Hosts default
  // to enabled; toggling adds/removes from this set.
  const [disabledHosts, setDisabledHosts] = useState<Set<string>>(() => {
    // Initial: only the first host enabled, the rest disabled. Keeps
    // the chart readable while the band/raw toggles are exercised.
    const all = ['api-1', 'api-2', 'api-3', 'api-4', 'api-5', 'api-6', 'api-7', 'api-8'];
    return new Set(all.slice(1));
  });

  const data = useDashboardData({
    hostCount: AGGREGATOR_HOST_COUNT,
    disabledHosts,
    chartOpts,
  });

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
      />
      <HostToggles
        hosts={data.hosts}
        hostColors={data.hostColors}
        enabledHosts={data.enabledHosts}
        onToggle={onToggleHost}
      />
      <CpuSection
        data={data}
        chartOpts={chartOpts}
        onChartOptsChange={setChartOpts}
      />
      <RequestsSection data={data} />
      <LogsSection data={data} />
    </div>
  );
}
