import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChartBand, ChartDots, ChartPoint, ChartSeries } from './Chart';

type Props = {
  title: string;
  series: ChartSeries[];
  bands?: ChartBand[];
  dots?: ChartDots[];
  tStart?: number;
  tEnd?: number;
  /**
   * Width — accepts a CSS px number or `'100%'` to fill the
   * container. ResizeObserver tracks the actual rendered width
   * from the container ref so percent values work without any
   * coordinate hacks.
   */
  width?: number | `${number}%`;
  height?: number;
  yMin?: number;
  yMax?: number;
  yFormat?: (v: number) => string;
};

/**
 * Canvas-based replacement for `Chart` (Recharts SVG).
 *
 * Same `Props` shape — drop-in. The motivation is the M3.5 friction
 * note's "SVG cliff": Recharts produces one DOM node per chart point
 * × series, plus per-tick reconciliation work that doesn't bound
 * with the visible window. At firehose × N-host loads the SVG node
 * count climbs into the tens of thousands and the renderer either
 * starves on layout work or OOMs on the retained DOM. PR #36's
 * heap-leak fixes mitigated the JS-side allocation churn but
 * recharts' SVG growth is structural — the structural fix is to
 * stop allocating DOM per data point and draw to a canvas instead.
 *
 * **Architecture:**
 *
 *   - One `<canvas>` per chart, sized via ResizeObserver to its
 *     container's width. Height is fixed (default 220 px). DPR
 *     scaling at draw time so the canvas stays sharp on Retina.
 *   - All chart elements (grid, bands, lines, dots, axis labels)
 *     draw in a single `useLayoutEffect` pass on the canvas's 2D
 *     context. No per-point DOM nodes. Total DOM nodes per chart:
 *     a small fixed handful (container + header + legend + canvas).
 *   - Header + legend stay HTML so they're inspectable + styleable
 *     without re-implementing CSS layout in canvas.
 *   - `React.memo` so the dashboard's 5 fps re-render cycle doesn't
 *     trigger redraws when the chart's data props haven't changed
 *     identity (matches the existing `Chart`'s memoisation
 *     contract — see PR #36).
 *
 * **What's missing vs Recharts (intentionally, for v1):**
 *
 *   - No tooltip on hover. The dashboard didn't use one.
 *   - No zoom / pan. Static window.
 *   - No animation on data changes. Set `isAnimationActive: false`
 *     was already the convention.
 *   - Y-axis ticks are computed from the rendered domain via a
 *     "nice round numbers" helper — not a 1:1 match to Recharts'
 *     algorithm, but visually close at this experiment's scales.
 *
 * History note: Recharts is fundamentally the right shape for
 * smaller / static charts (richer interactivity, declarative). The
 * canvas approach pays off specifically when (a) point counts are
 * large, (b) data updates frequently, and (c) interactivity is
 * minimal — the dashboard's 5 fps × hundreds-of-points × no-tooltip
 * profile fits this exactly.
 */
export const CanvasChart = memo(CanvasChartImpl);

function CanvasChartImpl({
  title,
  series,
  bands = [],
  dots = [],
  tStart,
  tEnd,
  width = '100%',
  height = 220,
  yMin: yMinOverride,
  yMax: yMaxOverride,
  yFormat = (v) => `${(v * 100).toFixed(0)}%`,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ResizeObserver on the container so percent widths work without
  // forcing the parent to compute pixels. Also handles window resize.
  // The canvas itself is sized in the draw effect using these
  // measurements + DPR.
  const [containerWidth, setContainerWidth] = useState<number>(
    typeof width === 'number' ? width : 0,
  );
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof width === 'number') {
      setContainerWidth(width);
      return;
    }
    // Initial measurement (ResizeObserver doesn't fire for the first paint).
    setContainerWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        setContainerWidth((prev) => (prev !== w ? w : prev));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  // Auto y-domain from the actual data unless overridden. Mirrors
  // the SVG `Chart`'s logic: use real min/max + a 10% padding so
  // the line doesn't kiss the edges. Memoised because `series` /
  // `bands` are stable references between snapshot ticks.
  const { yMin, yMax } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.value == null) continue;
        if (p.value < lo) lo = p.value;
        if (p.value > hi) hi = p.value;
      }
    }
    for (const b of bands) {
      for (const p of b.upper) {
        if (p.value == null) continue;
        if (p.value > hi) hi = p.value;
      }
      for (const p of b.lower) {
        if (p.value == null) continue;
        if (p.value < lo) lo = p.value;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const pad = (hi - lo) * 0.1 || Math.max(0.05, hi * 0.1);
    return {
      yMin: yMinOverride ?? Math.max(0, lo - pad),
      yMax: yMaxOverride ?? hi + pad,
    };
  }, [series, bands, yMinOverride, yMaxOverride]);

  // Y-axis tick stops. "Nice round numbers" — pick a step size from
  // {0.1, 0.2, 0.25, 0.5, 1, 2, ...} × pow10 such that the rendered
  // domain spans 4-7 ticks. The rendering loop draws labels + grid
  // lines at each. Recharts has a fancier algorithm but this looks
  // fine at the experiment's scales.
  const yTicks = useMemo(() => niceTicks(yMin, yMax, 5), [yMin, yMax]);

  // X-axis tick stops — pick ~5-6 evenly-spaced timestamps over the
  // visible window. Each gets a `toLocaleTimeString()` label.
  const xTicks = useMemo(() => {
    if (tStart == null || tEnd == null) return [];
    const ticks: number[] = [];
    const N = 5;
    for (let i = 0; i <= N; i++) {
      ticks.push(tStart + ((tEnd - tStart) * i) / N);
    }
    return ticks;
  }, [tStart, tEnd]);

  // The actual draw call. `useLayoutEffect` so the paint happens
  // before the browser commits a frame — avoids a blank flash when
  // the component first mounts. Deps are the props that affect the
  // rendered pixels; React.memo on the component handles the
  // outer "should we run at all" decision.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (containerWidth <= 0) return;
    if (tStart == null || tEnd == null) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(containerWidth * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, containerWidth, height);

    // Plot-area padding — same shape as Recharts' default.
    // - Left: 42 px reserved for y-axis labels (matches `width={42}`
    //   on the SVG `<YAxis>`).
    // - Right: 8 px (the Recharts margin).
    // - Top: 8 px.
    // - Bottom: 22 px for x-axis labels.
    const PAD_L = 42;
    const PAD_R = 8;
    const PAD_T = 8;
    const PAD_B = 22;
    const plotW = containerWidth - PAD_L - PAD_R;
    const plotH = height - PAD_T - PAD_B;
    if (plotW <= 0 || plotH <= 0) return;

    const span = tEnd - tStart;
    const yRange = yMax - yMin || 1;
    const xScale = (ts: number): number =>
      PAD_L + ((ts - tStart) / span) * plotW;
    const yScale = (v: number): number =>
      PAD_T + (1 - (v - yMin) / yRange) * plotH;

    // ── 1. Grid (under everything) ─────────────────────────────
    ctx.strokeStyle = 'rgba(127,127,127,0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (const tick of yTicks) {
      const y = yScale(tick);
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(PAD_L + plotW, y);
    }
    for (const tick of xTicks) {
      const x = xScale(tick);
      ctx.moveTo(x, PAD_T);
      ctx.lineTo(x, PAD_T + plotH);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ── 2. Bands (filled, on top of grid, under lines) ─────────
    // Walk the upper edge forward, lower edge backward, building
    // one closed path per contiguous run of defined upper+lower
    // values. Gaps (either side null) break the run.
    for (const b of bands) {
      ctx.fillStyle = b.color;
      ctx.globalAlpha = b.opacity ?? 0.12;
      // Both arrays are typically aligned 1:1 (same ts grid). Walk
      // them in lockstep; if the lengths differ we fall back to
      // ts-matching with a Map.
      const aligned = b.upper.length === b.lower.length;
      if (aligned) {
        let runStart = -1;
        for (let i = 0; i <= b.upper.length; i++) {
          const u = i < b.upper.length ? b.upper[i] : undefined;
          const l = i < b.lower.length ? b.lower[i] : undefined;
          const hasBoth =
            u != null &&
            l != null &&
            u.value != null &&
            l.value != null &&
            u.ts === l.ts;
          if (hasBoth && runStart < 0) {
            runStart = i;
          } else if (!hasBoth && runStart >= 0) {
            drawBandRun(ctx, b.upper, b.lower, runStart, i, xScale, yScale);
            runStart = -1;
          }
        }
      } else {
        // Fallback — match by ts. Slow path; only hits when the
        // upstream memo hasn't aligned the two edges. In practice
        // the cpu memo always emits them in lockstep.
        const lowerByTs = new Map<number, number>();
        for (const p of b.lower) {
          if (p.value != null) lowerByTs.set(p.ts, p.value);
        }
        let runStart = -1;
        const aligned: ChartPoint[] = [];
        const alignedLo: ChartPoint[] = [];
        for (const p of b.upper) {
          if (p.value == null || !lowerByTs.has(p.ts)) {
            if (runStart >= 0) {
              drawBandRun(ctx, aligned, alignedLo, runStart, aligned.length, xScale, yScale);
              runStart = -1;
            }
            continue;
          }
          if (runStart < 0) runStart = aligned.length;
          aligned.push(p);
          alignedLo.push({ ts: p.ts, value: lowerByTs.get(p.ts)! });
        }
        if (runStart >= 0) {
          drawBandRun(ctx, aligned, alignedLo, runStart, aligned.length, xScale, yScale);
        }
      }
    }
    ctx.globalAlpha = 1;

    // ── 3. Series (lines, on top of bands) ─────────────────────
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.5;
      ctx.globalAlpha = s.opacity ?? (s.dashed ? 0.7 : 0.95);
      ctx.lineJoin = 'round';
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath();
      let move = true;
      for (const p of s.points) {
        if (p.value == null) {
          move = true;
          continue;
        }
        const x = xScale(p.ts);
        const y = yScale(p.value);
        if (move) {
          ctx.moveTo(x, y);
          move = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // ── 4. Dot overlay for sparse line series (matches Chart's
    //    `SCATTER_DOT_THRESHOLD = 60` rule — see Chart.tsx). At
    //    dense point counts the dots are redundant; at sparse counts
    //    they're how isolated-defined values become visible.
    const SCATTER_DOT_THRESHOLD = 60;
    for (const s of series) {
      if (s.dashed) continue;
      if (s.points.length > SCATTER_DOT_THRESHOLD) continue;
      ctx.fillStyle = s.color;
      ctx.globalAlpha = s.opacity ?? 0.95;
      for (const p of s.points) {
        if (p.value == null) continue;
        ctx.beginPath();
        ctx.arc(xScale(p.ts), yScale(p.value), 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // ── 5. Anomaly dots (`dots` prop) on top of everything ─────
    for (const d of dots) {
      ctx.fillStyle = d.color;
      ctx.globalAlpha = 0.85;
      const r = d.radius ?? 2.5;
      for (const p of d.points) {
        if (p.value == null) continue;
        ctx.beginPath();
        ctx.arc(xScale(p.ts), yScale(p.value), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // ── 6. Axes — labels + axis lines. Drawn last so they sit
    //    on top of grid + data. Color matches the SVG chart's
    //    `rgba(127,127,127,0.55)` axis stroke + 60% opacity tick
    //    text.
    ctx.strokeStyle = 'rgba(127,127,127,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T);
    ctx.lineTo(PAD_L, PAD_T + plotH);
    ctx.lineTo(PAD_L + plotW, PAD_T + plotH);
    ctx.stroke();

    ctx.fillStyle = 'currentColor';
    ctx.globalAlpha = 0.6;
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    // Y-axis labels — right-aligned in the left margin.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of yTicks) {
      ctx.fillText(yFormat(tick), PAD_L - 4, yScale(tick));
    }
    // X-axis labels — centred under each tick.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tick of xTicks) {
      ctx.fillText(
        new Date(tick).toLocaleTimeString(),
        xScale(tick),
        PAD_T + plotH + 4,
      );
    }
    ctx.globalAlpha = 1;
  }, [
    series,
    bands,
    dots,
    tStart,
    tEnd,
    yMin,
    yMax,
    yTicks,
    xTicks,
    yFormat,
    containerWidth,
    height,
  ]);

  // Empty state — match the SVG chart's "waiting for data…" copy
  // + layout. Triggers when either the time domain isn't set yet
  // (first frame after mount) or there's no data.
  const empty =
    tStart == null ||
    tEnd == null ||
    (series.every((s) => s.points.length < 2) && bands.length === 0);

  return (
    <div ref={containerRef} className="chart">
      <div className="chart-header">
        <span className="chart-title">{title}</span>
        <span className="chart-legend">
          {series
            .filter((s) => !s.hideFromLegend)
            .map((s) => (
              <span key={s.name} className="legend-item">
                <span className="dot" style={{ background: s.color }} />
                {s.name}
                {s.stat != null && <span className="legend-stat">{s.stat}</span>}
              </span>
            ))}
        </span>
      </div>
      {empty ? (
        <div
          style={{
            width: '100%',
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span className="chart-empty">waiting for data…</span>
        </div>
      ) : (
        <canvas ref={canvasRef} style={{ display: 'block' }} />
      )}
    </div>
  );
}

/**
 * Draw one closed band path from `[lower[start..end-1]]` reversed +
 * `[upper[start..end-1]]` forward. Caller has already set fillStyle
 * and globalAlpha; we just emit the path + fill. Pulled out of the
 * main draw loop so the band-segmentation logic above stays
 * readable.
 */
function drawBandRun(
  ctx: CanvasRenderingContext2D,
  upper: ReadonlyArray<ChartPoint>,
  lower: ReadonlyArray<ChartPoint>,
  start: number,
  end: number,
  xScale: (ts: number) => number,
  yScale: (v: number) => number,
): void {
  if (end - start < 2) return;
  ctx.beginPath();
  for (let i = start; i < end; i++) {
    const p = upper[i];
    if (p.value == null) continue;
    const x = xScale(p.ts);
    const y = yScale(p.value);
    if (i === start) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = end - 1; i >= start; i--) {
    const p = lower[i];
    if (p.value == null) continue;
    ctx.lineTo(xScale(p.ts), yScale(p.value));
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Generate ~`target` "nice" tick values in `[lo, hi]`. Step size is
 * picked from {1, 2, 5} × power-of-10 so the result divides cleanly
 * (no `0.13`-ish ticks). Used for both the y-axis labels and the
 * grid lines.
 *
 * Edge case: `lo === hi` returns `[lo]` (single tick).
 */
function niceTicks(lo: number, hi: number, target: number): number[] {
  if (lo === hi) return [lo];
  if (lo > hi) [lo, hi] = [hi, lo];
  const range = hi - lo;
  const rawStep = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  let step: number;
  if (norm < 1.5) step = 1 * pow;
  else if (norm < 3) step = 2 * pow;
  else if (norm < 7) step = 5 * pow;
  else step = 10 * pow;
  const ticks: number[] = [];
  const first = Math.ceil(lo / step) * step;
  // Cap iteration count to handle floating-point edges that would
  // otherwise loop forever near zero.
  for (let v = first; v <= hi + step * 1e-9 && ticks.length < 50; v += step) {
    ticks.push(v);
  }
  return ticks;
}
