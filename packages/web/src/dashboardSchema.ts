/**
 * Dashboard-local constants. The event `schema`, `baselineSchema`, and
 * `HOSTS` have moved to `@pond-experiment/shared` so producer,
 * aggregator, and web all bind to the same domain. Per-host CPU means
 * are simulator-internal and live with whichever package runs the
 * simulator (M1: aggregator).
 */

/** Visible time axis for every chart in the dashboard. */
export const WINDOW_MS = 5 * 60 * 1000;

/** Chart line/band colours. Indexed by host position in `HOSTS`. */
export const PALETTE = [
  '#4c8bf5',
  '#2ec27e',
  '#a76bf5',
  '#f59f4c',
  '#3bc3c3',
  '#e28bd8',
];

/** Threshold for "high CPU" alerts in non-anomaly mode. */
export const HIGH_CPU_THRESHOLD = 0.7;

/** Empty-state singleton so a never-discovered host list keeps a stable identity. */
export const NO_HOSTS: readonly string[] = [];
