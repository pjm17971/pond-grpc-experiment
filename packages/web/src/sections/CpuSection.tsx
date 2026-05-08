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
 * The CPU section: header stats, the per-host line chart, two
 * independent overlay toggles, the σ slider, and the anomaly bucket
 * bar chart underneath.
 *
 * Two overlays the chart can carry, controlled by two toggles:
 *
 * - **Show ±σ bands** (`showBands`): dashed-line edges per host at
 *   `cpu_avg ± σ × cpu_sd` over the **1m baseline** window — the
 *   anomaly threshold visualisation. Comes with red anomaly dots
 *   placed at the per-tick `cpu_max` / `cpu_min` (the actual
 *   sample that broke through the band). The σ slider only does
 *   anything when this is on.
 *
 * - **Show raw points** (`showRaw`): two stacked filled bands per
 *   host visualising the **per-tick (200 ms slice)** distribution
 *   of the underlying samples — inner `current_avg ± current_sd`
 *   at 30% opacity, outer `cpu_min … cpu_max` at 10%. No dots.
 *   Distinct from the bands toggle: this is sample-distribution,
 *   not anomaly-threshold.
 */
export function CpuSection({ data, chartOpts, onChartOptsChange }: Props) {
  const { showBands, showRaw, sigma } = chartOpts;
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
          <label
            className="toggle"
            title="Render dashed-line edges at cpu_avg ± σ·cpu_sd over the 1m baseline plus anomaly dots at the per-tick extreme value (cpu_max / cpu_min)."
          >
            <input
              type="checkbox"
              checked={showBands}
              onChange={(e) => update({ showBands: e.target.checked })}
            />
            Show ±{sigma.toFixed(1)}σ bands
          </label>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.1}
            value={sigma}
            onChange={(e) => update({ sigma: parseFloat(e.target.value) })}
            disabled={!showBands}
            className="sigma-slider"
            aria-label="band width in σ"
          />
          <label
            className="toggle"
            title="Render two filled bands per host visualising the per-tick (200ms slice) distribution of samples: inner current_avg ± current_sd at 30% opacity, outer cpu_min … cpu_max at 10%. No dots."
          >
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => update({ showRaw: e.target.checked })}
            />
            Show raw points
          </label>
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
