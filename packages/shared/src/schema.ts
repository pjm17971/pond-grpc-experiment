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
 * `cpu_avg`/`cpu_sd` are nullable: the aggregator coerces undefined
 * reducer outputs to `null` defensively. Behaviour for empty
 * rolling windows depends on pond's silent-partition policy.
 *
 * `cpu_n` (baseline bucket count, gates render-readiness) and
 * `n_current` (count over the most recent 200ms slice) are always
 * numbers, even zero.
 *
 * `anomalies_above` / `anomalies_below` (added in step 4) are
 * array-kind columns. Each row carries an array indexed by the
 * snapshot's `thresholds` list — `anomalies_above[i]` = count of
 * raw samples in the current slice whose value exceeds
 * `cpu_avg + thresholds[i] * cpu_sd`. The dashboard interpolates
 * linearly between buckets for arbitrary σ slider values.
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
] as const satisfies SeriesSchema;

export type AggregateSchema = typeof aggregateSchema;
