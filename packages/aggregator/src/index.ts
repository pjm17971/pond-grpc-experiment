import { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import { startSimulator } from './simulator.js';
import { startServer } from './server.js';

const PORT = Number(process.env.AGGREGATOR_PORT ?? '8080');
const EVENTS_PER_SEC = Number(process.env.EVENTS_PER_SEC ?? '2');
const HOST_COUNT = Number(process.env.HOST_COUNT ?? '4');
const VARIABILITY = Number(process.env.VARIABILITY ?? '0.4');

const live = new LiveSeries({
  name: 'metrics',
  schema,
  retention: { maxAge: '6m' },
});

const stopSimulator = startSimulator(live, {
  eventsPerSec: EVENTS_PER_SEC,
  hostCount: HOST_COUNT,
  variability: VARIABILITY,
});

const server = await startServer({ port: PORT, live });

console.log(
  `aggregator listening on :${PORT} (events=${EVENTS_PER_SEC}/s, hosts=${HOST_COUNT}, variability=±${VARIABILITY})`,
);

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down…`);
  stopSimulator();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
