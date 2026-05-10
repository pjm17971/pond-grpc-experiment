import { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import { startIngest } from './ingest.js';
import { configureLateness, startGcObserver } from './metrics.js';
import { startServer } from './server.js';

const PORT = Number(process.env.AGGREGATOR_PORT ?? '8080');
// IPv4 explicit by default so macOS's IPv6-first `localhost` resolution
// doesn't try `::1:50051` while the producer is bound to `0.0.0.0`
// (IPv4-only). Friction-noted for M2 — see friction-notes/M2.md.
const PRODUCER_URL = process.env.PRODUCER_URL ?? '127.0.0.1:50051';

/**
 * Per-host stride-sampling factor for the aggregate pipeline's
 * baseline rolling. `SAMPLE_STRIDE=1` is the default (no sampling,
 * full firehose into the rolling); `SAMPLE_STRIDE=10` keeps every
 * 10th event per host going into the rolling, cutting per-partition
 * deque size ~10× while leaving rolling stats statistically
 * equivalent (`sd / sqrt(N)` grows √10 but stays orders of
 * magnitude below per-event noise at firehose). See
 * `friction-notes/rfcs/bounded-memory-sampling.md` for the math.
 *
 * Plumbed into `startAggregate` (not `startIngest`) so the
 * `LiveSeries` itself, `live.on('batch', cb)`, and the
 * non-partitioned globals rolling all see the **true firehose** —
 * the dashboard's `events_ingested_total` / `events_per_sec` /
 * `requests_ingested_total` reflect actual gRPC throughput
 * regardless of stride. Pre-0.17 the experiment's stride sampler
 * sat at the gRPC ingest hop and undercounted these by the
 * stride factor.
 */
const SAMPLE_STRIDE = Math.max(1, Number(process.env.SAMPLE_STRIDE ?? '1'));

/**
 * Late-event ordering for the LiveSeries. `'strict'` (the
 * default) **throws** on any out-of-order push. `'reorder'`
 * accepts late events up to `graceWindow` and inserts them at
 * the correct position in the live buffer.
 *
 * The pond-ts brief at `pond-ts/docs/briefs/grpc-late-data-validation.md`
 * asks the experiment to drive milestone-B sequencing by running
 * with `'reorder'` and measuring where pond's downstream pipelines
 * (rolling / fused / reduce) silently drop or miscount the late
 * events that LiveSeries successfully accepts. Per pond-ts's docs:
 * "rolling() / window() views over a live source do not re-flow
 * late events through historical windows — each reordered arrival
 * is a fresh event at its insertion point, nothing more." That
 * gap is exactly what milestone B is scoped to close.
 *
 * Default `'strict'` here keeps the existing benches and dashboard
 * runs unchanged; flip via env when running the late-data analysis
 * (`LATE_EVENT_FRACTION>0` on the producer + `ORDERING=reorder` on
 * the aggregator).
 */
const ORDERING: 'strict' | 'reorder' | 'drop' = (() => {
  const raw = process.env.ORDERING ?? 'strict';
  if (raw === 'strict' || raw === 'reorder' || raw === 'drop') return raw;
  console.warn(`unknown ORDERING=${raw}, defaulting to strict`);
  return 'strict';
})();
/**
 * Grace window for late events when `ORDERING='reorder'`. Must be
 * ≤ retention's `maxAge`, otherwise pond rejects the construction.
 * Tuned to match the producer's `LATE_EVENT_DELAY_TAIL_MS=30000`
 * default — late events at the 99th-percentile delay still land
 * inside the grace window.
 */
const GRACE_WINDOW_MS = Number(process.env.GRACE_WINDOW_MS ?? '30000');

const stopGc = startGcObserver();

// Configure the late-event correctness counters in metrics.ts. The
// baseline window length here mirrors the fused-rolling spec in
// `aggregate.ts` (the 1m window). Both feed the snapshot at
// `/metrics → late.*` exposed for the milestone-B friction note's
// drift-comparison harness — see `friction-notes/M3.5.md`'s late-
// data section. No-op at default `LATE_EVENT_FRACTION=0`.
configureLateness({
  baselineWindowMs: 60_000,
  graceWindowMs: GRACE_WINDOW_MS,
});

// Retention sized as a small ingest buffer, NOT the rolling's
// window store. Pond's `LivePartitionedFusedRolling` maintains its
// own per-partition deque (with the head-index amortised eviction
// added in 0.15.2), so the rolling's 1m baseline keeps emitting
// correctly even after `live` evicts the underlying events.
//
// History: 6m → 90s (step 7 follow-up, fixed an OOM at moderate
// rates) → 30s (this commit, fixes an OOM at firehose). At ~70k
// events/sec a 90s retention puts ~6.3M events × ~600 bytes =
// ~3.8GB into the live deque alone, which pushed V8 past its 4GB
// heap ceiling. 30s caps live retention at ~2.1M × ~600 = ~1.3GB,
// leaving headroom for the rolling state, snapshot history, and
// transient allocations.
const live = new LiveSeries({
  name: 'metrics',
  schema,
  retention: { maxAge: '30s' },
  ordering: ORDERING,
  // pond requires graceWindow ≤ retention.maxAge. Only attach the
  // grace window when reordering is on; under strict it has no
  // effect and pond would still validate it against retention.
  ...(ORDERING === 'reorder' ? { graceWindow: GRACE_WINDOW_MS } : {}),
});

const stopIngest = startIngest(live, {
  producerUrl: PRODUCER_URL,
  // Per-row push under late-data modes so a single past-grace event
  // (under `'reorder'`) or out-of-order event (under `'strict'`,
  // shouldn't happen by design but defensive) doesn't kill the rest
  // of the batch. `'strict'` + the experiment's default workload
  // never throws, so the bulk path is the right hot path there.
  pushStrategy: ORDERING === 'strict' ? 'bulk' : 'per-row',
});
const server = await startServer({
  port: PORT,
  live,
  // Route SAMPLE_STRIDE to the aggregate pipeline's per-host sample
  // op — see `startAggregate.AggregateOptions.sampleStride` for the
  // wiring and the `index.ts` comment block above for why this
  // moved out of `startIngest`.
  aggregateSampleStride: SAMPLE_STRIDE,
  // Match the source `LiveSeries`'s ordering on the per-partition
  // sub-series. Required under `'reorder'` — pond's `partitionBy`
  // defaults to `'strict'`, which would crash the partition router
  // on a late event the source already accepted. Surfaced by the
  // milestone-B drift harness; see friction-notes/M3.5.md (or
  // wherever the M4 note ends up landing).
  aggregatePartitionOrdering: ORDERING,
  aggregatePartitionGraceWindowMs:
    ORDERING === 'reorder' ? GRACE_WINDOW_MS : undefined,
});

console.log(
  `aggregator listening on :${PORT} (producer=${PRODUCER_URL}, sampleStride=${SAMPLE_STRIDE}, ordering=${ORDERING}${ORDERING === 'reorder' ? `, graceWindow=${GRACE_WINDOW_MS}ms` : ''})`,
);

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down…`);
  stopIngest();
  stopGc();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
