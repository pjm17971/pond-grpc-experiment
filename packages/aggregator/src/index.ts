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

// Retention sized to the fused rolling's longest window (1m baseline)
// plus headroom for boundary alignment + microtask drain. Earlier
// drafts used 6m, which over-provisioned by 4× and at firehose rates
// (5k+ events/sec) drove the aggregator's heap into V8's 2GB limit
// after ~25 minutes of uptime. Nothing downstream needs >1m of raw
// retention — the per-host fused rolling is the only consumer of
// `live`'s contents and its longest window is 1m. The aggregate-
// stream's snapshot history (M3.5 step 8) will live in a separate
// bounded ring keyed off `HostTick`s, not raw events.
const live = new LiveSeries({
  name: 'metrics',
  schema,
  retention: { maxAge: '90s' },
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
