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
 * `cpu_avg` and `cpu_sd` are nullable. Pond's clock trigger emits
 * one row per known partition per boundary — including silent
 * partitions whose rolling 1m window is empty — and the rolling
 * reducers return `undefined` over an empty window. The aggregator
 * translates those to `null` on the wire. So nulls are reachable
 * today: a host that stops sending events keeps emitting frames
 * with `cpu_avg: null, cpu_sd: null` for up to 1m of silence
 * (until the partition rolls fully out of the window).
 *
 * `cpu_n` is always a number — the bucket count, even zero. The
 * dashboard's render gate (`cpu_n >= 30`, the equivalent of pond's
 * raw-side `minSamples: 30` mask) keys off it.
 */
export const aggregateSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu_avg', kind: 'number', required: false },
  { name: 'cpu_sd', kind: 'number', required: false },
  { name: 'cpu_n', kind: 'number' },
] as const satisfies SeriesSchema;

export type AggregateSchema = typeof aggregateSchema;
