import { Fragment } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * A single time-stamped point.
 * `value` may be `undefined` to denote a gap — Recharts skips these
 * when the line/area has `connectNulls={false}`, producing a visible
 * break in the chart instead of a line drawn across the gap.
 */
export type ChartPoint = { ts: number; value: number | undefined };

export type ChartSeries = {
  name: string;
  color: string;
  points: ChartPoint[];
  dashed?: boolean;
  width?: number;
  opacity?: number;
  stat?: string;
  hideFromLegend?: boolean;
};

export type ChartBand = {
  name: string;
  color: string;
  upper: ChartPoint[];
  lower: ChartPoint[];
  opacity?: number;
};

export type ChartDots = {
  name: string;
  color: string;
  points: ChartPoint[];
  radius?: number;
};

type Props = {
  title: string;
  series: ChartSeries[];
  bands?: ChartBand[];
  dots?: ChartDots[];
  tStart?: number;
  tEnd?: number;
  width?: number;
  height?: number;
  yMin?: number;
  yMax?: number;
  yFormat?: (v: number) => string;
};

type Row = Record<string, number | undefined>;

function bandKey(name: string, side: 'lower' | 'upper'): string {
  return `__band_${name}_${side}`;
}

export function Chart({
  title,
  series,
  bands = [],
  dots = [],
  tStart,
  tEnd,
  width = 420,
  height = 220,
  yMin: yMinOverride,
  yMax: yMaxOverride,
  yFormat = (v) => `${(v * 100).toFixed(0)}%`,
}: Props) {
  // Merge series + band rows into the wide-format Recharts wants:
  // one entry per ts with every series/band value indexed by key.
  const byTs = new Map<number, Row>();
  const get = (ts: number): Row => {
    let row = byTs.get(ts);
    if (!row) {
      row = { ts };
      byTs.set(ts, row);
    }
    return row;
  };
  for (const s of series) for (const p of s.points) get(p.ts)[s.name] = p.value;
  for (const b of bands) {
    for (const p of b.upper) get(p.ts)[bandKey(b.name, 'upper')] = p.value;
    for (const p of b.lower) get(p.ts)[bandKey(b.name, 'lower')] = p.value;
  }
  const data = [...byTs.values()].sort(
    (a, b) => (a.ts as number) - (b.ts as number),
  );

  const allValues = [
    ...series.flatMap((s) => s.points.map((p) => p.value)),
    ...bands.flatMap((b) => [
      ...b.upper.map((p) => p.value),
      ...b.lower.map((p) => p.value),
    ]),
  ];

  if (data.length < 2 || tStart == null || tEnd == null) {
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
          <span className="chart-empty">waiting for data…</span>
        </div>
      </div>
    );
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of allValues) {
    if (v == null) continue;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  const yPad = (maxY - minY) * 0.1 || Math.max(0.05, maxY * 0.1);
  const yMin = yMinOverride ?? Math.max(0, minY - yPad);
  const yMax = yMaxOverride ?? maxY + yPad;

  return (
    <div className="chart">
      <div className="chart-header">
        <span className="chart-title">{title}</span>
        <span className="chart-legend">
          {series
            .filter((s) => !s.hideFromLegend)
            .map((s) => (
              <span key={s.name} className="legend-item">
                <span className="dot" style={{ background: s.color }} />
                {s.name}
                {s.stat != null && (
                  <span className="legend-stat">{s.stat}</span>
                )}
              </span>
            ))}
        </span>
      </div>
      <ResponsiveContainer width={width} height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
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
            domain={[yMin, yMax]}
            tickFormatter={yFormat}
            tick={{ fontSize: 10, fill: 'currentColor', opacity: 0.6 }}
            stroke="rgba(127,127,127,0.55)"
            width={42}
          />
          {bands.map((b) => (
            <Area
              key={`band-${b.name}`}
              type="monotone"
              dataKey={(d: Row) => {
                const lo = d[bandKey(b.name, 'lower')];
                const hi = d[bandKey(b.name, 'upper')];
                return lo == null || hi == null ? undefined : [lo, hi];
              }}
              stroke="none"
              fill={b.color}
              fillOpacity={b.opacity ?? 0.12}
              isAnimationActive={false}
              connectNulls={false}
              activeDot={false}
            />
          ))}
          {series.map((s) => {
            // Pair the line with a small Scatter overlay for "real" data
            // series (skip only dashed reference lines).
            // Recharts' Line can't render an isolated defined value with
            // `connectNulls={false}` — there's no segment to draw — so
            // a sparse stretch of one-defined-then-undefined points would
            // visually disappear entirely. The Scatter renders a marker
            // at every defined value; in dense regions the dot overlaps
            // the line and reads as a slightly thicker stroke, in sparse
            // regions it's the only thing that shows the data exists.
            // Raw-sample overlays in particular need the scatter — the
            // materialized grid alternates defined/undefined cells when
            // the source rate is below the grid step (e.g., during a
            // backgrounded-tab throttle), so most raw points are isolated.
            const showDots = !s.dashed;
            const lineOpacity = s.opacity ?? (s.dashed ? 0.7 : 0.95);
            return (
              <Fragment key={s.name}>
                <Line
                  type="monotone"
                  dataKey={s.name}
                  stroke={s.color}
                  strokeWidth={s.width ?? 1.5}
                  strokeDasharray={s.dashed ? '4 3' : undefined}
                  strokeOpacity={lineOpacity}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
                {showDots && (
                  <Scatter
                    dataKey={s.name}
                    fill={s.color}
                    fillOpacity={lineOpacity}
                    shape={(props: { cx?: number; cy?: number }) =>
                      props.cx == null || props.cy == null ? (
                        <g />
                      ) : (
                        <circle
                          cx={props.cx}
                          cy={props.cy}
                          r={1.5}
                          fill={s.color}
                        />
                      )
                    }
                    isAnimationActive={false}
                  />
                )}
              </Fragment>
            );
          })}
          {dots.map((d) => (
            <Scatter
              key={`dots-${d.name}`}
              data={d.points.map((p) => ({ ts: p.ts, anomaly: p.value }))}
              dataKey="anomaly"
              fill={d.color}
              shape={(props: { cx?: number; cy?: number }) =>
                props.cx == null || props.cy == null ? (
                  <g />
                ) : (
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={d.radius ?? 2.5}
                    fill={d.color}
                    stroke="white"
                    strokeWidth={0.8}
                  />
                )
              }
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
