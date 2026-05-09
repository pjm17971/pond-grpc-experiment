import { CanvasChart } from '../CanvasChart';
import { Chart } from '../Chart';
import { Stat } from '../Stat';
import type { DashboardData } from '../useDashboardData';

/**
 * Same chart-impl picker as CpuSection — see that file for the
 * `?canvas=0` / `?recharts=1` opt-out and rationale. Default is
 * the canvas chart so both CPU + Requests share one renderer
 * choice consistently.
 */
const USE_CANVAS_CHART = ((): boolean => {
  if (typeof window === 'undefined') return true;
  const p = new URLSearchParams(window.location.search);
  if (p.get('canvas') === '0' || p.get('recharts') === '1') return false;
  return true;
})();
const TimeChart = USE_CANVAS_CHART ? CanvasChart : Chart;

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
        <TimeChart
          title="Requests/sec per host"
          series={data.reqSeries}
          tStart={data.tStart}
          tEnd={data.tEnd}
          yFormat={(v) => v.toFixed(0)}
        />
      </div>
    </section>
  );
}
