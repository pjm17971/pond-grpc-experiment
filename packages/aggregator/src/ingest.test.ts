import { Server, ServerCredentials, type ServerWritableStream } from '@grpc/grpc-js';
import { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import {
  ProducerService,
  type Event,
  type ProducerServer,
  type SubscribeRequest,
} from '@pond-experiment/shared/grpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startIngest } from './ingest.js';

/**
 * Spin up a minimal in-process gRPC producer fake, dial it via
 * `startIngest`, and assert events flow into the LiveSeries.
 *
 * This is the symmetric counterpart of `producer/src/grpc.test.ts`:
 * that test verifies the server delivers Events to a client; this
 * verifies the aggregator's client correctly pushes them into pond.
 */
describe('aggregator gRPC ingest', () => {
  let server: Server;
  let port: number;
  let writers: Set<(event: Event) => void>;
  let live: LiveSeries<typeof schema>;
  let stopIngest: () => void;

  beforeEach(async () => {
    writers = new Set();
    server = new Server();
    const impl: ProducerServer = {
      subscribe(call: ServerWritableStream<SubscribeRequest, Event>) {
        const write = (event: Event) => {
          call.write(event);
        };
        writers.add(write);
        const cleanup = () => writers.delete(write);
        call.on('cancelled', cleanup);
        call.on('close', cleanup);
        call.on('error', cleanup);
      },
    };
    server.addService(ProducerService, impl);
    port = 51100 + Math.floor(Math.random() * 800);
    await new Promise<void>((res, rej) => {
      server.bindAsync(
        `127.0.0.1:${port}`,
        ServerCredentials.createInsecure(),
        (err) => (err ? rej(err) : res()),
      );
    });

    live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    stopIngest = startIngest(live, { producerUrl: `127.0.0.1:${port}` });
  });

  afterEach(async () => {
    stopIngest();
    await new Promise<void>((res) => server.tryShutdown(() => res()));
  });

  it('pushes streamed Events into the local LiveSeries', async () => {
    // Wait for the ingest client's stream to register.
    await waitFor(() => writers.size === 1);

    for (const write of writers) {
      write({ timeMs: 1_700_000_000_000, cpu: 0.5, requests: 100, host: 'api-1' });
      write({ timeMs: 1_700_000_000_050, cpu: 0.6, requests: 110, host: 'api-2' });
    }

    await waitFor(() => live.length === 2, 1500);
    expect(live.length).toBe(2);
    expect(live.first()?.get('host')).toBe('api-1');
    expect(live.last()?.get('cpu')).toBeCloseTo(0.6);
  });
});

function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline)
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      else setTimeout(tick, 10);
    };
    tick();
  });
}
