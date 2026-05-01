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
 * `cpu_avg` and `cpu_sd` are nullable so a future step that emits
 * stats-with-no-samples (when a host has new samples this tick but
 * none in the rolling window) can land without a wire-shape change.
 * `cpu_n` is always a number — the bucket count, even zero.
 *
 * Step 1 of M3.5 only emits hosts with non-empty buckets, so the
 * `null` branch isn't reachable on the wire today; the type keeps
 * the contract forward-compatible.
 */
export const aggregateSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu_avg', kind: 'number', required: false },
  { name: 'cpu_sd', kind: 'number', required: false },
  { name: 'cpu_n', kind: 'number' },
] as const satisfies SeriesSchema;

export type AggregateSchema = typeof aggregateSchema;
