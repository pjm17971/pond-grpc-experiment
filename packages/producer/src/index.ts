import type { EventBatch } from '@pond-experiment/shared/grpc';
import { startSimulator } from './simulator.js';
import { startGrpcServer } from './grpc.js';

const PORT = Number(process.env.GRPC_PORT ?? '50051');
const EVENTS_PER_SEC = Number(process.env.EVENTS_PER_SEC ?? '2');
const HOST_COUNT = Number(process.env.HOST_COUNT ?? '4');
const VARIABILITY = Number(process.env.VARIABILITY ?? '0.4');

// One subscriber per open Subscribe stream. The simulator emits one
// EventBatch per tick to every subscriber; subscribers close
// themselves on stream cancel/close/error via the unsubscribe
// returned by `subscribe()`.
const subscribers = new Set<(batch: EventBatch) => void>();

const stopSimulator = startSimulator(
  {
    eventsPerSec: EVENTS_PER_SEC,
    hostCount: HOST_COUNT,
    variability: VARIABILITY,
  },
  (batch) => {
    for (const write of subscribers) write(batch);
  },
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

console.log(
  `producer listening on :${PORT} (events=${EVENTS_PER_SEC}/s, hosts=${HOST_COUNT}, variability=±${VARIABILITY})`,
);

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down…`);
  stopSimulator();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
