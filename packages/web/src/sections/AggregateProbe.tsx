import { useEffect, useMemo, useState } from 'react';
import { HOSTS } from '@pond-experiment/shared';
import type { RemoteAggregateState } from '../useRemoteAggregateSeries';

type Props = {
  /**
   * Aggregate stream state, owned by `useDashboardData`. Single
   * subscription per dashboard tab — earlier drafts of this section
   * called `useRemoteAggregateSeries` directly, which doubled the
   * `/live-agg` WS connections (one for the probe, one for the
   * bands). The hook owner now passes the state in.
   */
  aggregate: RemoteAggregateState;
};

const STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting',
  connected: 'live',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
};

/**
 * Debug panel for the M3.5 aggregate stream. Renders the most recent
 * `HostTick` per host (one row per host, columns: cpu_avg, cpu_sd,
 * cpu_n, age) plus connection status, σ-threshold list, and the
 * fan-in counters.
 *
 * Hosts ordered per the canonical `HOSTS` declaration so palette
 * order matches the rest of the dashboard, with any unknown hosts
 * appended in arrival order. Hosts that haven't ticked yet are
 * omitted (matches the aggregator's silent-host-omit policy).
 */
export function AggregateProbe({ aggregate }: Props) {
  const { latestPerHost, thresholds, status, counters } = aggregate;
  // Drive the "age" column off a 1Hz wall-clock state bump so the
  // displayed staleness keeps growing during a disconnect (when no
  // ticks arrive and React would otherwise not re-render). 1s is fine
  // for a debug panel; sub-second precision in the staleness column
  // wouldn't read better.
  const [renderedAt, setRenderedAt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setRenderedAt(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const orderedHosts = useMemo(() => {
    const known: string[] = [];
    const seen = new Set<string>();
    for (const h of HOSTS) {
      if (latestPerHost.has(h)) {
        known.push(h);
        seen.add(h);
      }
    }
    const extra: string[] = [];
    for (const h of latestPerHost.keys()) {
      if (!seen.has(h)) extra.push(h);
    }
    extra.sort();
    return [...known, ...extra];
  }, [latestPerHost]);

  return (
    <section className="metric-section aggregate-probe">
      <div className="section-header">
        <h2>Aggregate stream</h2>
        <div className="section-stats">
          <span
            className={`connection-indicator connection-indicator-${status}`}
            role="status"
            aria-label={`live-agg connection ${status}`}
          >
            <span className="connection-dot" />
            <span className="connection-label">
              /live-agg {STATUS_LABEL[status] ?? status}
            </span>
          </span>
          <span className="section-note">
            σ thresholds: [{thresholds.length > 0 ? thresholds.join(', ') : '—'}]
          </span>
        </div>
      </div>
      <div className="aggregate-probe-counts">
        <span>
          <strong>{counters.latestFrameEvents}</strong> raw events in latest
          frame
        </span>
        <span>
          <strong>{counters.totalEvents.toLocaleString()}</strong> raw /{' '}
          <strong>{counters.totalFrames.toLocaleString()}</strong> frames since
          connect
        </span>
        <span>
          fan-in:{' '}
          <strong>
            {counters.totalFrames === 0
              ? '—'
              : (counters.totalEvents / counters.totalFrames).toFixed(1)}
          </strong>{' '}
          raw/frame
        </span>
      </div>
      {orderedHosts.length === 0 ? (
        <p className="section-note">
          Waiting for first tick frame from the aggregator…
        </p>
      ) : (
        <table className="aggregate-probe-table">
          <thead>
            <tr>
              <th>host</th>
              <th>cpu_avg</th>
              <th>cpu_sd</th>
              <th>cpu_n</th>
              <th>age</th>
            </tr>
          </thead>
          <tbody>
            {orderedHosts.map((host) => {
              const tick = latestPerHost.get(host);
              if (!tick) return null;
              const ageMs = renderedAt - tick.ts;
              return (
                <tr key={host}>
                  <td>{host}</td>
                  <td>{formatPct(tick.cpu_avg)}</td>
                  <td>{formatPct(tick.cpu_sd)}</td>
                  <td>{tick.cpu_n}</td>
                  <td>{formatAge(ageMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function formatPct(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function formatAge(ms: number): string {
  if (ms < 0) return 'future';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
