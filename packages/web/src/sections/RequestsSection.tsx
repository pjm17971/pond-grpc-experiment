import { Chart } from '../Chart';
import { Stat } from '../Stat';
import type { DashboardData } from '../useDashboardData';

type Props = {
  data: DashboardData;
};

/**
 * The Requests section: total req/sec across enabled hosts, lifetime
 * request count, and a per-host smoothed line chart. The y-axis renders
 * raw integer counts (no percentage formatting).
 */
export function RequestsSection({ data }: Props) {
  return (
    <section className="metric-section">
      <header className="section-header">
        <h2>Requests</h2>
        <div className="section-stats">
          <Stat
            label="Req/sec (total)"
            value={
              data.totalReqPerSec > 0 ? data.totalReqPerSec.toFixed(0) : '—'
            }
          />
          <Stat
            label="Total requests"
            value={
              data.totalRequests != null
                ? data.totalRequests.toLocaleString()
                : '—'
            }
          />
        </div>
      </header>
      <div className="section-charts">
        <Chart
          title="Requests/sec per host"
          series={data.reqSeries}
          tStart={data.tStart}
          tEnd={data.tEnd}
          width={720}
          yFormat={(v) => v.toFixed(0)}
        />
      </div>
    </section>
  );
}
