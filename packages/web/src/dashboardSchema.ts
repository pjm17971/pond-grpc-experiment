/**
 * Dashboard-local constants. The event `schema`, `baselineSchema`, and
 * `HOSTS` have moved to `@pond-experiment/shared` so producer,
 * aggregator, and web all bind to the same domain. Per-host CPU means
 * are simulator-internal and live with whichever package runs the
 * simulator (M1: aggregator).
 */

/** Visible time axis for every chart in the dashboard. */
export const WINDOW_MS = 5 * 60 * 1000;

/**
 * Chart line/band colours. Indexed by host position in `HOSTS`.
 * Ten distinct hues so every host in the canonical 10-host
 * declaration gets its own colour — past index 10 the lookup
 * cycles (`PALETTE[i % PALETTE.length]`), but at the experiment's
 * dashboard scales (≤10 hosts in the chart) every host renders
 * uniquely.
 */
export const PALETTE = [
  '#4c8bf5',
  '#2ec27e',
  '#a76bf5',
  '#f59f4c',
  '#3bc3c3',
  '#e28bd8',
  '#f5d24c',
  '#f56b6b',
  '#6bf5b3',
  '#8b9ef5',
];

/** Threshold for "high CPU" alerts in non-anomaly mode. */
export const HIGH_CPU_THRESHOLD = 0.7;

/** Empty-state singleton so a never-discovered host list keeps a stable identity. */
export const NO_HOSTS: readonly string[] = [];
