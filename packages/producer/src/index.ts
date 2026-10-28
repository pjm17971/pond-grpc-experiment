import { createServer } from 'node:http';
import type { EventBatch } from '@pond-experiment/shared/grpc';
import { startSimulator } from './simulator.js';
import { startGrpcServer } from './grpc.js';

const PORT = Number(process.env.GRPC_PORT ?? '50051');
const EVENTS_PER_SEC = Number(process.env.EVENTS_PER_SEC ?? '2');
const HOST_COUNT = Number(process.env.HOST_COUNT ?? '4');
const VARIABILITY = Number(process.env.VARIABILITY ?? '0.4');
// Unset: no metrics server. Set: `GET /metrics` returns the counters
// below as JSON (same shape as the Rust producer).
const METRICS_PORT = process.env.METRICS_PORT || undefined;
const QUEUE_BATCHES = 64;

const counters = {
  batchesProduced: 0,
  rowsProduced: 0,
  // Summed over subscribers: a batch dropped for two slow subscribers
  // counts twice.
  droppedBatches: 0,
  droppedRows: 0,
};
const startedAt = Date.now();

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
    // Counted only while someone is subscribed, as in the Rust producer
    // (which skips the simulator when nobody is).
    if (subscribers.size === 0) return;
    counters.batchesProduced++;
    counters.rowsProduced += batch.events.length;
    for (const write of subscribers) write(batch);
  },
);

const server = await startGrpcServer({
  port: PORT,
  queueBatches: QUEUE_BATCHES,
  onDrop: (batch) => {
    counters.droppedBatches++;
    counters.droppedRows += batch.events.length;
  },
  onSubscribe: (write) => {
    subscribers.add(write);
    return () => {
      subscribers.delete(write);
    };
  },
});

if (METRICS_PORT !== undefined) {
  const metrics = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        uptimeSec: (Date.now() - startedAt) / 1000,
        subscribers: subscribers.size,
        queueBatches: QUEUE_BATCHES,
        ...counters,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    metrics.once('error', reject);
    metrics.listen(Number(METRICS_PORT), resolve);
  });
}

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
