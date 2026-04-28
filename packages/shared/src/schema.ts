/**
 * The metric event schema. Each push is `[time, cpu, requests, host]`.
 *
 * Declared `as const` so pond-ts narrows column types end-to-end —
 * `event.get('cpu')` returns `number`, `event.get('host')` returns
 * `string`, no casts.
 */
export const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

/**
 * Two-column schema for the static threshold line. Used with
 * `useTimeSeries` to mount a fixed series the chart overlays in
 * threshold mode.
 */
export const baselineSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const;
