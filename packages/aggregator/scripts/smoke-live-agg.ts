import {
  allocatePort,
  spawnAggregator,
  spawnProducer,
} from '@pond-experiment/dev-utils';
import WebSocket from 'ws';
import { decode } from '@pond-experiment/shared';

/**
 * Spin up producer + aggregator, connect to `/live-agg`, print the
 * snapshot frame and the first 3 tick frames, then tear down. Manual
 * smoke that the M3.5 step-1 wire actually emits real frames against
 * a real producer (not just the in-test loopback).
 */
async function main(): Promise<void> {
  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();

  const producer = await spawnProducer({
    grpcPort,
    eventsPerSec: 10,
    hostCount: 5,
  });
  const aggregator = await spawnAggregator({
    httpPort,
    producerUrl: `127.0.0.1:${grpcPort}`,
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/live-agg`);
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    console.log('connected to /live-agg');

    let appendsSeen = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no tick frames in 3s')),
        3000,
      );
      ws.on('message', (data) => {
        const msg = decode(data.toString());
        if (msg.type === 'aggregate-snapshot') {
          console.log('snapshot:', JSON.stringify(msg, null, 2));
        } else if (msg.type === 'aggregate-append') {
          appendsSeen += 1;
          console.log(`tick #${appendsSeen}:`, JSON.stringify(msg, null, 2));
          if (appendsSeen >= 3) {
            clearTimeout(timer);
            resolve();
          }
        } else {
          console.log('unexpected:', msg.type);
        }
      });
    });
    ws.close();
  } finally {
    await aggregator.stop('SIGTERM');
    await producer.stop('SIGTERM');
  }
}

await main();
