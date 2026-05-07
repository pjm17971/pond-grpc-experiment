import type { SeriesSchema } from 'pond-ts/types';

/**
 * The metric event schema. Each push is `[time, cpu, requests, host]`.
 *
 * Declared `as const` so pond-ts narrows column types end-to-end —
 * `event.get('cpu')` returns `number`, `event.get('host')` returns
 * `string`, no casts. The `satisfies SeriesSchema` clause catches
 * column-kind typos at the definition site rather than at every
 * downstream consumer.
 */
export const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const satisfies SeriesSchema;

export type Schema = typeof schema;

/**
 * Two-column schema for the static threshold line. Used with
 * `useTimeSeries` to mount a fixed series the chart overlays in
 * threshold mode.
 */
export const baselineSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const satisfies SeriesSchema;

/**
 * Client-side schema mirroring the wire's `HostTick`. Lets the
 * dashboard mount a `LiveSeries<AggregateSchema>` and run pond
 * pipelines (`partitionBy('host')`, windowing, smoothing, etc.)
 * over the aggregate stream the same way it runs them over the raw
 * `/live` stream.
 *
 * `cpu_avg`/`cpu_sd`/`requests_avg` are nullable: the aggregator
 * coerces undefined reducer outputs to `null` defensively.
 * Behaviour for empty rolling windows depends on pond's silent-
 * partition policy.
 *
 * `cpu_n` / `requests_n` (baseline bucket counts, gate render-
 * readiness) and `n_current` (count over the most recent 200ms
 * slice) are always numbers, even zero. `requests_sum` likewise —
 * sum over the 1m baseline; defaults to 0 for an empty bucket.
 *
 * `anomalies_above` / `anomalies_below` (added in step 4) are
 * array-kind columns. Each row carries an array indexed by the
 * snapshot's `thresholds` list — `anomalies_above[i]` = count of
 * raw samples in the current slice whose value exceeds
 * `cpu_avg + thresholds[i] * cpu_sd`. The dashboard interpolates
 * linearly between buckets for arbitrary σ slider values.
 *
 * Step 5 adds the requests stats (`requests_avg`, `requests_sum`,
 * `requests_n`) sourced from the same 1m baseline window as the CPU
 * stats. No band/anomaly arrays for requests — the dashboard
 * renders requests as a smoothed line, not a band.
 *
 * Step 6 adds `window_age_seconds` — elapsed wall-clock seconds
 * the rolling 1m window covers at this row's tick. Lets the
 * dashboard divide rolling sums by the actual data-window length
 * rather than a hardcoded 60s, so freshly-started aggregators
 * don't show a 60s diagonal warmup ramp on rate displays. Caps at
 * 60 once the window is full. Same value across hosts at a tick;
 * repeated per row to keep the chart's historical pipeline self-
 * describing.
 *
 * Step 7 adds `cpu_min` / `cpu_max` — per-tick (200ms) min/max of
 * the `cpu` column. Drives the dashboard's "show min/max envelope"
 * toggle (the WIRE.md repurpose of the legacy raw-samples scatter
 * overlay) — gives the chart visible per-tick texture even when
 * the 1m smoothed line is flat. Both `null` when the 200ms slice
 * is empty (`n_current === 0`).
 */
export const aggregateSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu_avg', kind: 'number', required: false },
  { name: 'cpu_sd', kind: 'number', required: false },
  { name: 'cpu_n', kind: 'number' },
  { name: 'n_current', kind: 'number' },
  { name: 'anomalies_above', kind: 'array' },
  { name: 'anomalies_below', kind: 'array' },
  { name: 'requests_avg', kind: 'number', required: false },
  { name: 'requests_sum', kind: 'number' },
  { name: 'requests_n', kind: 'number' },
  { name: 'window_age_seconds', kind: 'number' },
  { name: 'cpu_min', kind: 'number', required: false },
  { name: 'cpu_max', kind: 'number', required: false },
] as const satisfies SeriesSchema;

export type AggregateSchema = typeof aggregateSchema;
