import { useMemo } from 'react';
import { HOSTS } from '@pond-experiment/shared';
import { useRemoteAggregateSeries } from '../useRemoteAggregateSeries';

type Props = {
  url: string;
};

const STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting',
  connected: 'live',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
};

/**
 * Debug panel for the M3.5 aggregate stream. Subscribes to
 * `/live-agg`, displays the most recent `HostTick` per host (one row
 * per host, columns: cpu_avg, cpu_sd, cpu_n, age) plus connection
 * status and the snapshot's threshold list.
 *
 * This is **diagnostic only** in step 2 — the production CPU section
 * still renders bands from the raw `/live` stream's baseline pipeline.
 * Step 3 swaps those bands to source from `cpu_avg`/`cpu_sd` here;
 * step 4+ adds anomalies, requests, and globals as they land on the
 * wire and migrates the corresponding sections.
 *
 * Hosts ordered per the canonical `HOSTS` declaration so palette
 * order matches the rest of the dashboard, with any unknown hosts
 * appended in arrival order. Hosts that haven't ticked yet are
 * omitted (matches the aggregator's silent-host-omit policy).
 */
export function AggregateProbe({ url }: Props) {
  const { latestPerHost, thresholds, status } = useRemoteAggregateSeries(url);
  const renderedAt = Date.now();

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
        <h2>Aggregate stream (M3.5 step 1)</h2>
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
