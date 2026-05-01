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

/**
 * Aggregate-stream URL (`/live-agg`). Defaults to deriving the path
 * from `VITE_WS_URL` so a single env var configures both endpoints;
 * `VITE_WS_AGG_URL` is the explicit override when the two streams
 * land on different hosts (e.g. M4 fan-out across aggregators).
 *
 * URL parsing via the `URL` API rather than string slicing so query
 * strings (`?token=…`), trailing slashes (`/live/`), and host-only
 * URLs (`ws://host`) are all handled correctly. Falls back to a
 * naïve append on parse error.
 */
const RAW_WS_URL =
  import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080/live';
const AGG_WS_URL =
  import.meta.env.VITE_WS_AGG_URL ?? deriveAggregateUrl(RAW_WS_URL);

function deriveAggregateUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Trim a trailing slash so `/live/` and `/live` derive the same
    // aggregate path. Anchor the substitution with `=== '/live'` to
    // avoid eating part of `/livestream` etc.
    const path = u.pathname.replace(/\/$/, '');
    u.pathname = path === '/live' ? '/live-agg' : `${path}/live-agg`;
    return u.toString();
  } catch {
    return `${rawUrl}-agg`;
  }
}

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
    showBands: true,
    // Show raw samples by default — the most direct visual signal of
    // "data is flowing right now". When the source pauses, the raw line
    // breaks immediately at the next undefined cell; the smoothed line
    // can lag because its rolling window still contains pre-pause data.
    showRaw: true,
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

  const data = useDashboardData({ disabledHosts, chartOpts });

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
        onToggle={onToggleHost}
      />
      <CpuSection
        data={data}
        chartOpts={chartOpts}
        onChartOptsChange={setChartOpts}
      />
      <RequestsSection data={data} />
      <LogsSection data={data} />
      <AggregateProbe url={AGG_WS_URL} />
    </div>
  );
}
