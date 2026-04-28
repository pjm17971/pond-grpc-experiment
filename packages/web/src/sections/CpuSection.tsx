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
 * The CPU section: header stats, the per-host line chart with bands
 * and anomaly dots, the band toggles + σ slider, and the bucket bar
 * chart underneath.
 *
 * Two display modes:
 *   - threshold mode (showBands off) — flat 70% reference line on the
 *     line chart, alert count = events above 70%, bars = alert counts
 *   - anomaly mode (showBands on)    — per-host ±σ bands + outlier
 *     dots, anomaly count = points outside the band, bars = anomaly counts
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
          <Stat
            label={showBands ? 'Anomalies' : 'Alerts'}
            value={showBands ? data.cpuAnomalyCount : data.cpuAlertCount}
          />
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
          width={720}
          yMin={0.2}
          yMax={0.9}
        />
        <div className="chart-toggles">
          <label className="toggle">
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
          <label className="toggle">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => update({ showRaw: e.target.checked })}
            />
            Show raw samples
          </label>
        </div>
        <BarChart
          title={
            showBands
              ? 'Anomalies — 15s buckets'
              : 'High CPU alerts — 15s buckets'
          }
          emptyLabel={showBands ? 'no anomalies yet' : 'no alerts yet'}
          bars={data.bars}
          tStart={data.tStart}
          tEnd={data.tEnd}
          width={720}
          height={100}
        />
      </div>
    </section>
  );
}
