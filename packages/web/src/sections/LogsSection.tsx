import type { DashboardData } from '../useDashboardData';

type Props = {
  data: DashboardData;
};

/**
 * Logs section — most recent host-tick frames from the aggregate
 * stream's windowed snapshot, newest first. Each row is one
 * `(host, ts)` pair from `/live-agg` carrying the per-host tick
 * aggregates (cpu_avg over the 1m baseline, n_current as the count
 * of raw samples in the leading-edge slice, requests_avg as the
 * running average). Step 9 repurpose: pre-step-9 the section
 * iterated raw `cpu`/`requests` events from `/live`'s `LiveSeries`,
 * which is gone post-firehose-retirement; the aggregate wire's per-
 * tick rollups are the only stream the dashboard subscribes to now.
 *
 * Demonstrates direct iteration over a `LiveSeries<aggregateSchema>`
 * snapshot — same affordance as the pre-step-9 version, just on the
 * aggregate stream. The `recentTicks` derivation lives in
 * `useDashboardData` so this component stays a pure renderer.
 */
export function LogsSection({ data }: Props) {
  const { recentTicks, hostColors } = data;
  return (
    <section className="logs-section">
      <header className="section-header">
        <h2>Logs</h2>
        <div className="section-note">
          last 20 host ticks from /live-agg, newest first
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Host</th>
            <th>CPU avg (1m)</th>
            <th>n (slice)</th>
            <th>Requests avg</th>
          </tr>
        </thead>
        <tbody>
          {recentTicks.map((tick, i) => {
            const color = hostColors[tick.host];
            return (
              <tr key={`${tick.ts}-${tick.host}-${i}`}>
                <td>{new Date(tick.ts).toLocaleTimeString()}</td>
                <td>
                  <span
                    className="host-pill"
                    style={{ borderColor: color, color }}
                  >
                    {tick.host}
                  </span>
                </td>
                <td>
                  {tick.cpu_avg != null
                    ? `${(tick.cpu_avg * 100).toFixed(1)}%`
                    : '—'}
                </td>
                <td>{tick.n_current}</td>
                <td>
                  {tick.requests_avg != null
                    ? tick.requests_avg.toFixed(1)
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
