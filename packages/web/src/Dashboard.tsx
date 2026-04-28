import { useState } from 'react';
import { CpuSection } from './sections/CpuSection';
import { HostToggles } from './sections/HostToggles';
import { LogsSection } from './sections/LogsSection';
import { PageSummary } from './sections/PageSummary';
import { RequestsSection } from './sections/RequestsSection';
import { SimulatorControls } from './sections/SimulatorControls';
import type { ChartOpts } from './useDashboardData';
import { useDashboardData } from './useDashboardData';
import { useSimulator } from './useSimulator';
import type { SimulatorParams } from './useSimulator';

/**
 * The dashboard is a layout shell. All state lives here as a small set
 * of plain `useState`s; everything derived from the live series flows
 * through `useDashboardData`. Each section is a pure renderer of the
 * data hook's output plus whatever UI state it needs to round-trip.
 *
 *   simulator params  → useSimulator (drives the LiveSeries)
 *   simulator + UI    → useDashboardData (the pond pipeline)
 *   data hook output  → section components
 */
export function Dashboard() {
  // ── UI state ─────────────────────────────────────────────────────
  const [simParams, setSimParams] = useState<SimulatorParams>({
    eventsPerSec: 2,
    hostCount: 4,
    variability: 0.4,
  });
  const [chartOpts, setChartOpts] = useState<ChartOpts>({
    showBands: true,
    // Show raw samples by default — the most direct visual signal of
    // "data is flowing right now". When the source pauses, the raw line
    // breaks immediately at the next undefined cell; the smoothed line
    // can lag because its rolling window still contains pre-pause data.
    showRaw: true,
    sigma: 2,
    eventsPerSec: 2,
  });
  // The set of hosts the user has explicitly disabled. Hosts default
  // to enabled; toggling adds/removes from this set.
  const [disabledHosts, setDisabledHosts] = useState<Set<string>>(() => {
    // Initial: only the first host enabled, the rest disabled. Keeps
    // the chart readable while the band/raw toggles are exercised.
    const all = ['api-1', 'api-2', 'api-3', 'api-4', 'api-5', 'api-6', 'api-7', 'api-8'];
    return new Set(all.slice(1));
  });

  // ── Data ─────────────────────────────────────────────────────────
  const data = useDashboardData({
    hostCount: simParams.hostCount,
    disabledHosts,
    chartOpts: { ...chartOpts, eventsPerSec: simParams.eventsPerSec },
  });
  useSimulator(data.liveSeries, simParams);

  // ── Handlers ────────────────────────────────────────────────────
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
      <SimulatorControls params={simParams} onChange={setSimParams} />
      <PageSummary
        totalEvents={data.totalEvents}
        hostCount={data.hosts.length}
        totalRequests={data.totalRequests}
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
