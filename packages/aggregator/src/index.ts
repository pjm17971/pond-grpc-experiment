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
  retention: { maxAge: '30s' },
});

const stopIngest = startIngest(live, { producerUrl: PRODUCER_URL });
const server = await startServer({ port: PORT, live });

console.log(
  `aggregator listening on :${PORT} (producer=${PRODUCER_URL})`,
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
