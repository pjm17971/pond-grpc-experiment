import { BarChart } from '../BarChart';
import { Chart } from '../Chart';
import { Stat } from '../Stat';
import type { ChartOpts, DashboardData } from '../useDashboardData';

type Props = {
  data: DashboardData;
  chartOpts: ChartOpts;
  onChartOptsChange: (next: ChartOpts) => void;
};

/**
 * The CPU section: header stats, the per-host line chart with two
 * stacked bands (inner ±σ + outer min/max) plus anomaly dots, the
 * σ slider, and the anomaly bucket bar chart underneath.
 *
 * Single display mode now — the previous showBands / showRaw
 * toggles were retired in the dashboard-feedback round when the
 * stacked bands made both signals always-visible. The σ slider
 * controls the inner band's width; the outer min/max band tracks
 * the per-tick `cpu_min` / `cpu_max` extrema directly and is
 * independent of σ.
 */
export function CpuSection({ data, chartOpts, onChartOptsChange }: Props) {
  const { sigma } = chartOpts;
  const update = (patch: Partial<ChartOpts>) =>
    onChartOptsChange({ ...chartOpts, ...patch });

  return (
    <section className="metric-section">
      <header className="section-header">
        <h2>CPU</h2>
        <div className="section-stats">
          <Stat
            label="Rolling 1m avg"
            value={
              data.rollingCpu != null
                ? `${(data.rollingCpu * 100).toFixed(1)}%`
                : '—'
            }
          />
          <Stat
            label="EMA trend"
            value={
              data.trendCpu != null
                ? `${(data.trendCpu * 100).toFixed(1)}%`
                : '—'
            }
          />
          <Stat label="Anomalies" value={data.cpuAnomalyCount} />
        </div>
      </header>
      <div className="section-charts">
        <Chart
          title="CPU per host"
          series={data.cpuChartSeries}
          bands={data.cpuBands}
          dots={data.cpuDots}
          tStart={data.tStart}
          tEnd={data.tEnd}
          yMin={0.2}
          yMax={0.9}
        />
        <div className="chart-toggles">
          <span className="toggle-static">
            ±{sigma.toFixed(1)}σ band (inner) · min/max envelope (outer)
          </span>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.1}
            value={sigma}
            onChange={(e) => update({ sigma: parseFloat(e.target.value) })}
            className="sigma-slider"
            aria-label="inner band width in σ"
          />
        </div>
        <BarChart
          title="Anomalies — 15s buckets"
          emptyLabel="no anomalies yet"
          bars={data.bars}
          tStart={data.tStart}
          tEnd={data.tEnd}
          height={100}
        />
      </div>
    </section>
  );
}
