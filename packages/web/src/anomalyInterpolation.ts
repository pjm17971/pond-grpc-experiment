/**
 * Linear interpolation between σ-threshold buckets.
 *
 * The aggregate stream emits `anomalies_above[i]` / `anomalies_below[i]`
 * — the count of samples in the most recent slice that exceed
 * `cpu_avg + thresholds[i] * cpu_sd` (above) or fall below
 * `cpu_avg - thresholds[i] * cpu_sd` (below). The user's σ slider
 * is continuous (typically 0.5 → 4 in 0.1 steps); this helper maps
 * the slider value to an estimated count by linearly interpolating
 * between adjacent buckets in the threshold list.
 *
 * Worked example from `WIRE.md`:
 *   counts = [876, 62, 12, 1, 0]
 *   thresholds = [1, 1.5, 2, 2.5, 3]
 *   σ = 1.25 → bucket [0..1] (between 1 and 1.5), t = 0.5
 *   → 876 + (62 - 876) * 0.5 = 469
 *
 * `WIRE.md` also notes that gaussian-tailed counts decay
 * exponentially, so a `log(count)` interpolation is more faithful
 * to the underlying distribution. Linear is good enough at the
 * chart's sized-dot resolution; switch to log-linear if dot
 * positioning starts looking lumpy.
 *
 * Out-of-range σ clamps to the nearest endpoint:
 *   - σ ≤ thresholds[0]: returns counts[0]
 *   - σ ≥ thresholds[last]: returns counts[last]
 *
 * Empty arrays (the aggregator's "stats unstable, no anomalies
 * counted" gating signal) return 0.
 */
export function countAtSigma(
  counts: ReadonlyArray<number>,
  sigma: number,
  thresholds: ReadonlyArray<number>,
): number {
  if (counts.length === 0 || thresholds.length === 0) return 0;
  if (counts.length !== thresholds.length) {
    // Wire-shape drift between the snapshot frame's `thresholds`
    // and the per-row `anomalies_above[]`/`anomalies_below[]`
    // length. Defensive: return 0 rather than throw, surface in
    // logs only if it ever fires.
    return 0;
  }
  if (sigma <= thresholds[0]) return counts[0];
  if (sigma >= thresholds[thresholds.length - 1]) {
    return counts[counts.length - 1];
  }
  let i = 0;
  while (i + 1 < thresholds.length && thresholds[i + 1] < sigma) {
    i += 1;
  }
  const span = thresholds[i + 1] - thresholds[i];
  const t = span === 0 ? 0 : (sigma - thresholds[i]) / span;
  return counts[i] + (counts[i + 1] - counts[i]) * t;
}
