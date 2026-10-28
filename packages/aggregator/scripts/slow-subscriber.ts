/**
 * Check the producer's backpressure: one subscriber reads normally, one
 * stops reading (its gRPC stream is paused) for most of the run. The
 * slow one should fall behind, have its oldest batches dropped and
 * counted, while the fast one gets every batch and the producer's memory
 * stays flat.
 *
 * The Rust producer counts a stalled subscriber's drops when it next
 * reads, so for Rust `droppedWhilePaused` stays near 0 and the drops
 * appear in `droppedTotal` after the resume.
 *
 *   PRODUCER_IMPL=rust pnpm --filter @pond-experiment/aggregator exec tsx scripts/slow-subscriber.ts --P=100 --N=200 --seconds=10
 */
import { execFileSync } from 'node:child_process';
import { credentials } from '@grpc/grpc-js';
import {
  ProducerClient,
  SubscribeRequest,
  type EventBatch,
} from '@pond-experiment/shared/grpc';
import { allocatePort, spawnProducer } from '@pond-experiment/dev-utils';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, Number(v)];
  }),
);
const P = args.P ?? 100;
// The test client must keep up with the fast subscriber: at 100 × 1000
// one Node client can't decode two 100k rows/s streams, and the "fast"
// one gets drops too.
const N = args.N ?? 200;
const seconds = args.seconds ?? 10;

const grpcPort = await allocatePort();
const metricsPort = await allocatePort();
const producer = await spawnProducer({
  grpcPort,
  metricsPort,
  eventsPerSec: N,
  hostCount: P,
});
const metrics = async () =>
  (await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).json()) as {
    batchesProduced: number;
    rowsProduced: number;
    droppedBatches: number;
    droppedRows: number;
  };
const rssMb = () =>
  Number(execFileSync('ps', ['-o', 'rss=', '-p', String(producer.pid)])) / 1024;

const client = new ProducerClient(
  `127.0.0.1:${grpcPort}`,
  credentials.createInsecure(),
);
let fastRows = 0;
let fastBatches = 0;
let slowRows = 0;
let slowBatches = 0;
const fast = client.subscribe(SubscribeRequest.create());
fast.on('data', (b: EventBatch) => {
  fastBatches++;
  fastRows += b.events.length;
});
fast.on('error', () => {});
const slow = client.subscribe(SubscribeRequest.create());
slow.on('data', (b: EventBatch) => {
  slowBatches++;
  slowRows += b.events.length;
});
slow.on('error', () => {});

await sleep(1000);
const before = await metrics();
slow.pause();
const rss: number[] = [rssMb()];
for (let i = 0; i < seconds; i++) {
  await sleep(1000);
  rss.push(rssMb());
}
const paused = await metrics();
slow.resume();
await sleep(1000);
const after = await metrics();
fast.cancel();
slow.cancel();
client.close();
await producer.stop('SIGTERM');

console.log(
  JSON.stringify(
    {
      impl: process.env.PRODUCER_IMPL === 'rust' ? 'rust' : 'node',
      P,
      N,
      pausedSeconds: seconds,
      produced: { batches: after.batchesProduced, rows: after.rowsProduced },
      droppedWhilePaused: {
        batches: paused.droppedBatches - before.droppedBatches,
        rows: paused.droppedRows - before.droppedRows,
      },
      droppedTotal: { batches: after.droppedBatches, rows: after.droppedRows },
      fast: { batches: fastBatches, rows: fastRows },
      slow: { batches: slowBatches, rows: slowRows },
      // produced = slow received + dropped + still in flight at the end.
      slowUnaccounted: after.rowsProduced - slowRows - after.droppedRows,
      fastMissing: after.rowsProduced - fastRows,
      producerRssMb: rss.map((x) => Math.round(x)),
    },
    null,
    2,
  ),
);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
