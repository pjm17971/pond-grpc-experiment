import { writeHeapSnapshot } from 'node:v8';
import { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import { startIngest } from './ingest.js';
import { startGcObserver } from './metrics.js';
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
 * Override the `LiveSeries.retention.maxAge` from env. Default `30s`
 * (the post-firehose-OOM fix per the comment block below). Set this
 * to `90s` or `6m` to reproduce the historical OOM cells when
 * profiling for the pond-ts column-native-live-pipeline brief.
 * Accepts pond's `DurationLiteral` shape; passed straight through.
 */
const LIVE_RETENTION = process.env.LIVE_RETENTION ?? '30s';

/**
 * Heap-snapshot profiling hook. Set `HEAP_DUMP_AT_SEC=75` to
 * schedule a `v8.writeHeapSnapshot()` call N seconds after startup —
 * tuned so the source `LiveSeries` deque has had time to fully
 * populate (~75s × ~70k/s = ~5.25M events at firehose, near the
 * documented OOM cell). The snapshot path is logged so the caller
 * can analyse it post-run. Gated on the env so non-profile runs
 * pay zero cost. Companion analyser at
 * `scripts/analyse-heap-snapshot.ts`.
 */
const HEAP_DUMP_AT_SEC = process.env.HEAP_DUMP_AT_SEC
  ? Number(process.env.HEAP_DUMP_AT_SEC)
  : undefined;
const HEAP_DUMP_PATH = process.env.HEAP_DUMP_PATH;

const stopGc = startGcObserver();

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
  retention: { maxAge: LIVE_RETENTION as `${number}s` },
});

const stopIngest = startIngest(live, {
  producerUrl: PRODUCER_URL,
});
const server = await startServer({
  port: PORT,
  live,
  // Route SAMPLE_STRIDE to the aggregate pipeline's per-host sample
  // op — see `startAggregate.AggregateOptions.sampleStride` for the
  // wiring and the `index.ts` comment block above for why this
  // moved out of `startIngest`.
  aggregateSampleStride: SAMPLE_STRIDE,
});

console.log(
  `aggregator listening on :${PORT} (producer=${PRODUCER_URL}, sampleStride=${SAMPLE_STRIDE}, retention=${LIVE_RETENTION}${
    HEAP_DUMP_AT_SEC !== undefined ? `, heap-dump-at=${HEAP_DUMP_AT_SEC}s` : ''
  })`,
);

if (HEAP_DUMP_AT_SEC !== undefined) {
  setTimeout(() => {
    const path = HEAP_DUMP_PATH ?? `/tmp/aggregator-${Date.now()}.heapsnapshot`;
    console.log(`writing heap snapshot to ${path}…`);
    const t0 = performance.now();
    writeHeapSnapshot(path);
    const ms = performance.now() - t0;
    console.log(`heap snapshot written: ${path} (${ms.toFixed(0)}ms)`);
    console.log(
      `live.length=${live.length}, pond.stats()=${JSON.stringify(live.stats())}`,
    );
  }, HEAP_DUMP_AT_SEC * 1000);
}

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down…`);
  stopIngest();
  stopGc();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
