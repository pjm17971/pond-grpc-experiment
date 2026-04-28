import type { DashboardData } from '../useDashboardData';

type Props = {
  data: DashboardData;
};

/**
 * The Logs section: the most recent 20 raw events from the windowed
 * snapshot, newest first. Demonstrates direct event iteration —
 * `timeSeries.toArray()` gives a typed `EventForSchema<S>[]` and
 * `e.get('cpu')` etc. narrow on the schema with no casts.
 */
export function LogsSection({ data }: Props) {
  const { timeSeries, hostColors } = data;
  return (
    <section className="logs-section">
      <header className="section-header">
        <h2>Logs</h2>
        <div className="section-note">last 20 events across all hosts</div>
      </header>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Host</th>
            <th>CPU</th>
            <th>Requests</th>
          </tr>
        </thead>
        <tbody>
          {timeSeries &&
            timeSeries
              .toArray()
              .slice(-20)
              .reverse()
              .map((e, i) => {
                const ts = e.key().timestampMs();
                const host = e.get('host');
                const color = hostColors[host];
                return (
                  <tr key={`${ts}-${i}`}>
                    <td>{new Date(ts).toLocaleTimeString()}</td>
                    <td>
                      <span
                        className="host-pill"
                        style={{ borderColor: color, color }}
                      >
                        {host}
                      </span>
                    </td>
                    <td>{(e.get('cpu') * 100).toFixed(1)}%</td>
                    <td>{e.get('requests')}</td>
                  </tr>
                );
              })}
        </tbody>
      </table>
    </section>
  );
}
