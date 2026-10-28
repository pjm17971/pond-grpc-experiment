import {
  Server,
  ServerCredentials,
  type ServerWritableStream,
} from '@grpc/grpc-js';
import {
  ProducerService,
  type EventBatch,
  type ProducerServer,
  type SubscribeRequest,
} from '@pond-experiment/shared/grpc';

export type GrpcServerOptions = {
  port: number;
  host?: string;
  /**
   * Called once per opened Subscribe stream. Pass each `EventBatch`
   * to `write` to forward it as one gRPC frame. Return an unsubscribe
   * function that the server invokes on stream end / cancel / error.
   */
  onSubscribe: (write: (batch: EventBatch) => void) => () => void;
  /**
   * Batches a subscriber may fall behind before its oldest are dropped
   * (default 64). Counted on top of what grpc-js itself buffers (its
   * stream's `highWaterMark`, 16 objects).
   */
  queueBatches?: number;
  /** Called with each batch dropped for a slow subscriber. */
  onDrop?: (batch: EventBatch) => void;
};

export type RunningGrpcServer = {
  stop: () => Promise<void>;
};

/**
 * Start the producer's gRPC server. v1 has one RPC: `Subscribe`,
 * server-streaming Events for the lifetime of the stream. No
 * request fields, no per-client filtering (M4 territory).
 */
export async function startGrpcServer(
  opts: GrpcServerOptions,
): Promise<RunningGrpcServer> {
  const server = new Server();

  const impl: ProducerServer = {
    subscribe(call: ServerWritableStream<SubscribeRequest, EventBatch>) {
      const unsubscribe = opts.onSubscribe(
        boundedWriter(call, opts.queueBatches ?? 64, opts.onDrop),
      );
      const cleanup = () => {
        unsubscribe();
      };
      call.on('cancelled', cleanup);
      call.on('close', cleanup);
      call.on('error', cleanup);
    },
  };

  server.addService(ProducerService, impl);

  const address = `${opts.host ?? '0.0.0.0'}:${opts.port}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(address, ServerCredentials.createInsecure(), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown((err) => {
          if (err) {
            // tryShutdown failed (active streams?). Fall back to forceShutdown.
            server.forceShutdown();
          }
          resolve();
        });
      }),
  };
}

/**
 * A writer that honours the stream's backpressure. `call.write` returns
 * false once grpc-js's own buffer is full, which happens when HTTP/2
 * flow control stops it sending (the subscriber is not reading fast
 * enough). From then until `'drain'` batches wait in a queue of at most
 * `max`; past that the oldest waiting batch is dropped, so a slow
 * subscriber never stalls the simulator or the other subscribers.
 */
export function boundedWriter(
  call: {
    write: (b: EventBatch) => boolean;
    once: (e: 'drain', f: () => void) => unknown;
  },
  max: number,
  onDrop?: (batch: EventBatch) => void,
): (batch: EventBatch) => void {
  const queue: EventBatch[] = [];
  let blocked = false;
  const flush = () => {
    blocked = false;
    while (queue.length > 0) {
      if (!call.write(queue.shift()!)) {
        blocked = true;
        call.once('drain', flush);
        return;
      }
    }
  };
  return (batch) => {
    if (blocked) {
      queue.push(batch);
      if (queue.length > max) onDrop?.(queue.shift()!);
      return;
    }
    if (!call.write(batch)) {
      blocked = true;
      call.once('drain', flush);
    }
  };
}
