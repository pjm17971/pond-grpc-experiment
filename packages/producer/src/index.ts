import { createServer } from 'node:http';
import type { EventBatch } from '@pond-experiment/shared/grpc';
import { startSimulator } from './simulator.js';
import { startGrpcServer } from './grpc.js';
import { startLateInjector, parseHostBias } from './lateInjector.js';

const PORT = Number(process.env.GRPC_PORT ?? '50051');
const METRICS_PORT = Number(process.env.METRICS_PORT ?? '50052');
const EVENTS_PER_SEC = Number(process.env.EVENTS_PER_SEC ?? '2');
const HOST_COUNT = Number(process.env.HOST_COUNT ?? '4');
const VARIABILITY = Number(process.env.VARIABILITY ?? '0.4');

/**
 * Late-event injection — the milestone-B driver work. Default
 * `LATE_EVENT_FRACTION=0` is a no-op (producer behaves exactly as
 * pre-injection), so existing benches and the dashboard's normal
 * mode aren't affected. See `packages/producer/src/lateInjector.ts`
 * + the brief at `pond-ts/docs/briefs/grpc-late-data-validation.md`.
 */
const LATE_EVENT_FRACTION = Number(process.env.LATE_EVENT_FRACTION ?? '0');
const LATE_EVENT_DELAY_MS = Number(process.env.LATE_EVENT_DELAY_MS ?? '5000');
const LATE_EVENT_DELAY_TAIL_MS = Number(
  process.env.LATE_EVENT_DELAY_TAIL_MS ?? '30000',
);
const LATE_EVENT_HOST_BIAS = parseHostBias(process.env.LATE_EVENT_HOST_BIAS);
const LATE_EVENT_SEED = Number(process.env.LATE_EVENT_SEED ?? '1');

// One subscriber per open Subscribe stream. The simulator emits one
// EventBatch per tick to every subscriber; subscribers close
// themselves on stream cancel/close/error via the unsubscribe
// returned by `subscribe()`.
const subscribers = new Set<(batch: EventBatch) => void>();

// The simulator's downstream — fans out a batch to every connected
// subscriber. Used as the *downstream* of the late-injector so on-
// time and (delayed) late events both flow through the same fan-out
// path.
const broadcast = (batch: EventBatch): void => {
  for (const write of subscribers) write(batch);
};

const lateInjector =
  LATE_EVENT_FRACTION > 0
    ? startLateInjector(broadcast, {
        fraction: LATE_EVENT_FRACTION,
        delayMeanMs: LATE_EVENT_DELAY_MS,
        delayTailMs: LATE_EVENT_DELAY_TAIL_MS,
        hostBias: LATE_EVENT_HOST_BIAS,
        seed: LATE_EVENT_SEED,
      })
    : null;

const stopSimulator = startSimulator(
  {
    eventsPerSec: EVENTS_PER_SEC,
    hostCount: HOST_COUNT,
    variability: VARIABILITY,
  },
  lateInjector ? lateInjector.wrappedOnBatch : broadcast,
);

const server = await startGrpcServer({
  port: PORT,
  onSubscribe: (write) => {
    subscribers.add(write);
    return () => {
      subscribers.delete(write);
    };
  },
});

/**
 * Tiny `/metrics` HTTP endpoint exposing the late-injector's
 * counters. Only running when late-event injection is on; the
 * default `LATE_EVENT_FRACTION=0` skips the listen call so this
 * doesn't affect the existing producer's port surface unless you
 * opt in via env. JSON for easy curl + jq + bench-script
 * consumption.
 */
const metricsServer = lateInjector
  ? createServer((req, res) => {
      if (req.url === '/metrics') {
        const m = lateInjector.metrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(m));
      } else {
        res.writeHead(404);
        res.end();
      }
    })
  : null;
metricsServer?.listen(METRICS_PORT);

console.log(
  `producer listening on :${PORT} (events=${EVENTS_PER_SEC}/s, hosts=${HOST_COUNT}, variability=±${VARIABILITY})`,
);
if (lateInjector) {
  console.log(
    `late-event injection ON: fraction=${LATE_EVENT_FRACTION}, delay=${LATE_EVENT_DELAY_MS}ms (tail ${LATE_EVENT_DELAY_TAIL_MS}ms), seed=${LATE_EVENT_SEED}, bias=${JSON.stringify(LATE_EVENT_HOST_BIAS ?? {})}`,
  );
  console.log(`metrics endpoint listening on :${METRICS_PORT}/metrics`);
}

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down…`);
  lateInjector?.stop();
  metricsServer?.close();
  stopSimulator();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
