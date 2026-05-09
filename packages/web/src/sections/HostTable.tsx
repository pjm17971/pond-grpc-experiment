import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { HostTick, RankKey } from '@pond-experiment/shared';

type Props = {
  /**
   * Hosts the wire is currently shipping (server-side top-N + any
   * hysteresis carry-overs). The table renders **only these** rows
   * — distinct from the old chip row which showed every host ever
   * seen.
   */
  currentTopHosts: ReadonlySet<string>;
  /** Latest tick per host — drives the "Load" + "Current" cell values. */
  latestPerHost: ReadonlyMap<string, HostTick>;
  /** Stable per-host colour for the dot + sparkline stroke. */
  hostColors: Record<string, string>;
  /**
   * Chart-visibility toggle. Hosts in this set render in the CPU
   * + Requests charts; hosts outside it are dropped client-side.
   * The wire still ships them (server doesn't know), so the row
   * stays in the table.
   */
  enabledHosts: Set<string>;
  /** Click toggles the row's chart-visibility. */
  onToggle: (host: string) => void;
  topN: number;
  onTopNChange: (n: number) => void;
  rankBy: RankKey;
  onRankByChange: (k: RankKey) => void;
  /**
   * Per-host short window of `rankBy` values for the sparkline column.
   * See `useDashboardData.sparklineData`. Empty for hosts that don't
   * yet have data in the windowed snapshot.
   */
  sparklineData: ReadonlyMap<string, ReadonlyArray<number>>;
};

/** Rank-by dropdown options. Wire labels paired with display strings. */
const RANK_OPTIONS: ReadonlyArray<{
  key: RankKey;
  label: string;
  /** How to format this metric's value in the "Load" column. */
  format: (v: number) => string;
}> = [
  { key: 'cpu_avg', label: '1m CPU', format: (v) => `${(v * 100).toFixed(0)}%` },
  {
    key: 'cpu_sd',
    label: '1m volatility',
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    // Sum (NOT mean) — `requests_avg` in pond means "mean request
    // count per event" which doesn't track throughput. `requests_sum`
    // is total requests in the 1m window and ranks identically to
    // req/sec at fixed window length. Display the sum directly
    // (less surprising than a derived rate).
    key: 'requests_sum',
    label: '1m requests',
    format: (v) => v.toLocaleString(),
  },
];

/**
 * Top-N dropdown values. Discrete because typical legible host
 * counts are small; a slider over a 1–15 range was overkill UX
 * for a discrete control.
 */
const TOP_N_OPTIONS = [1, 2, 3, 5, 8, 10, 15] as const;

/**
 * Formats `current_avg` (a 200ms-slice mean, may be null when the
 * slice was empty) as a percentage with 1 decimal — matches the
 * "Current" column. Null/undefined render as a dim em-dash.
 */
const formatCurrent = (v: number | null | undefined): string =>
  typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '—';

/**
 * The host table — replaces the chip row + slider + faded-pill
 * combo with an information-dense sortable view. Rows are the
 * server's currently-shipped top-N (one per host, sorted by the
 * rank metric descending). The two dropdowns above the table
 * drive the wire's projection: top-N count and the rank metric.
 *
 * **Animated reorder** (deferred). The first iteration tried a
 * hand-rolled FLIP via `useLayoutEffect` + `getBoundingClientRect`
 * + transient `translateY`, but rapid re-renders at 5 fps fought
 * the rAF-based snap/release sequence and rows occasionally got
 * stuck with stale transforms. Punted to a follow-up — the static
 * table is the right primary form, animation is polish.
 */
export function HostTable({
  currentTopHosts,
  latestPerHost,
  hostColors,
  enabledHosts,
  onToggle,
  topN,
  onTopNChange,
  rankBy,
  onRankByChange,
  sparklineData,
}: Props) {
  const rankOption = RANK_OPTIONS.find((o) => o.key === rankBy)!;

  // Build sorted rows: top hosts by rankBy descending. Hosts with
  // null on the rank column sort to the bottom (matches the server's
  // rule). `latestPerHost.get(host)` may be undefined briefly on the
  // first frame after a host appears in the cut — skip those rows
  // rather than render placeholders.
  const sortedRows = useMemo(() => {
    const rows: Array<{ host: string; tick: HostTick }> = [];
    for (const host of currentTopHosts) {
      const tick = latestPerHost.get(host);
      if (tick) rows.push({ host, tick });
    }
    rows.sort((a, b) => {
      const av = typeof a.tick[rankBy] === 'number' ? (a.tick[rankBy] as number) : -Infinity;
      const bv = typeof b.tick[rankBy] === 'number' ? (b.tick[rankBy] as number) : -Infinity;
      return bv - av;
    });
    return rows;
  }, [currentTopHosts, latestPerHost, rankBy]);

  return (
    <div className="host-table-shell">
      <div className="host-table-controls">
        <span className="control-label">Top</span>
        <select
          className="top-n-select"
          value={topN}
          onChange={(e) => onTopNChange(parseInt(e.target.value, 10))}
          aria-label="top-N hosts"
        >
          {TOP_N_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="control-label">hosts by</span>
        <select
          className="rank-by-select"
          value={rankBy}
          onChange={(e) => onRankByChange(e.target.value as RankKey)}
          aria-label="rank metric"
        >
          {RANK_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <table className="host-table">
        <thead>
          <tr>
            <th aria-label="visible-in-chart" className="check-col"></th>
            <th className="host-col">Host</th>
            <th className="num-col">{rankOption.label}</th>
            <th className="num-col">Current</th>
            <th className="spark-col">Trend</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(({ host, tick }) => {
            const enabled = enabledHosts.has(host);
            const color = hostColors[host];
            const rankVal = tick[rankBy];
            const rankCell =
              typeof rankVal === 'number' ? rankOption.format(rankVal) : '—';
            return (
              <tr key={host} className={enabled ? 'row-on' : 'row-off'}>
                <td className="check-col">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => onToggle(host)}
                    aria-label={`toggle ${host}`}
                  />
                </td>
                <td className="host-col">
                  <span
                    className="host-dot"
                    style={{ background: color } as CSSProperties}
                  />
                  <span className="host-name">{host}</span>
                </td>
                <td className="num-col">{rankCell}</td>
                <td className="num-col">{formatCurrent(tick.current_avg)}</td>
                <td className="spark-col">
                  <Sparkline
                    color={color}
                    points={sparklineData.get(host) ?? []}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Inline canvas sparkline. ~80 px wide × 18 px tall, draws the
 * `points` array as a polyline normalised to its own min/max so
 * the shape is visible even when the absolute values are tiny.
 * Gap-tolerant: arrays under 2 points render empty.
 */
function Sparkline({
  color,
  points,
}: {
  color: string;
  points: ReadonlyArray<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = 80;
    const H = 18;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (points.length < 2) return;
    let min = Infinity;
    let max = -Infinity;
    for (const v of points) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    // Inset 1px top/bottom so a flat-top line isn't clipped.
    const yPad = 1;
    const yScale = H - yPad * 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = (i / (points.length - 1)) * W;
      const y = H - yPad - ((points[i] - min) / range) * yScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [color, points]);
  return <canvas ref={canvasRef} className="spark" />;
}
