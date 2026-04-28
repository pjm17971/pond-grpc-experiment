import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

export type Bar = {
  start: number;
  end: number;
  count: number;
};

type Props = {
  title: string;
  emptyLabel?: string;
  bars: Bar[];
  tStart?: number;
  tEnd?: number;
  width?: number;
  height?: number;
};

export function BarChart({
  title,
  emptyLabel = 'no events yet',
  bars,
  tStart,
  tEnd,
  width = 420,
  height = 110,
}: Props) {
  if (tStart == null || tEnd == null || bars.length === 0) {
    return (
      <div className="chart">
        <div className="chart-header">
          <span className="chart-title">{title}</span>
        </div>
        <div
          style={{
            width,
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span className="chart-empty">{emptyLabel}</span>
        </div>
      </div>
    );
  }

  // Use the bucket midpoint as the x-axis position so bars centre over their
  // 15-second slot when Recharts spaces them by a continuous time scale.
  const data = bars.map((b) => ({
    ts: (b.start + b.end) / 2,
    width: b.end - b.start,
    count: b.count,
  }));
  const maxCount = Math.max(1, ...bars.map((b) => b.count));

  return (
    <div className="chart">
      <div className="chart-header">
        <span className="chart-title">{title}</span>
      </div>
      <ResponsiveContainer width={width} height={height}>
        <RBarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="rgba(127,127,127,0.18)" strokeDasharray="2 3" />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={[tStart, tEnd]}
            tickFormatter={(t) => new Date(t).toLocaleTimeString()}
            tick={{ fontSize: 10, fill: 'currentColor', opacity: 0.6 }}
            stroke="rgba(127,127,127,0.55)"
            allowDataOverflow
          />
          <YAxis
            domain={[0, maxCount]}
            tick={{ fontSize: 10, fill: 'currentColor', opacity: 0.6 }}
            stroke="rgba(127,127,127,0.55)"
            width={42}
            allowDecimals={false}
          />
          <Bar
            dataKey="count"
            fill="#e23b3b"
            fillOpacity={0.85}
            isAnimationActive={false}
          />
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}
