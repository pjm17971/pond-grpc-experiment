import { credentials } from '@grpc/grpc-js';
import {
  ProducerClient,
  SubscribeRequest,
  type Event,
} from '@pond-experiment/shared/grpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGrpcServer, type RunningGrpcServer } from './grpc.js';

describe('producer gRPC server', () => {
  let server: RunningGrpcServer;
  let port: number;
  let subscribers = new Set<(event: Event) => void>();

  beforeEach(async () => {
    subscribers = new Set();
    port = 50100 + Math.floor(Math.random() * 800);
    server = await startGrpcServer({
      port,
      host: '127.0.0.1',
      onSubscribe: (write) => {
        subscribers.add(write);
        return () => {
          subscribers.delete(write);
        };
      },
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('streams Events from onSubscribe to the client', async () => {
    const client = new ProducerClient(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    );
    const received: Event[] = [];
    const call = client.subscribe(SubscribeRequest.create());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('no events received within 1500ms')),
        1500,
      );
      call.on('data', (event: Event) => {
        received.push(event);
        if (received.length === 2) {
          clearTimeout(timeout);
          resolve();
        }
      });
      call.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Synthesize two events into the producer's fan-out.
      setTimeout(() => {
        for (const write of subscribers) {
          write({ timeMs: 1_700_000_000_000, cpu: 0.5, requests: 100, host: 'api-1' });
          write({ timeMs: 1_700_000_000_001, cpu: 0.6, requests: 110, host: 'api-2' });
        }
      }, 100);
    });

    call.cancel();
    client.close();

    expect(received).toHaveLength(2);
    expect(received[0].host).toBe('api-1');
    expect(received[0].cpu).toBeCloseTo(0.5);
    expect(received[1].host).toBe('api-2');
  });

  it('unsubscribes the writer when the stream is cancelled', async () => {
    const client = new ProducerClient(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    );
    const call = client.subscribe(SubscribeRequest.create());
    // grpc-js emits an 'error' event with code CANCELLED on
    // call.cancel(). We're cancelling on purpose; absorb it so
    // vitest doesn't surface the expected error.
    call.on('error', () => {});

    // Wait a tick for the server to register the subscriber.
    await waitFor(() => subscribers.size === 1);
    expect(subscribers.size).toBe(1);

    call.cancel();
    client.close();

    // The server should drop the subscriber on stream cancel.
    await waitFor(() => subscribers.size === 0, 1000);
    expect(subscribers.size).toBe(0);
  });
});

function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
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
