import { Server, ServerCredentials, type ServerWritableStream } from '@grpc/grpc-js';
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
      const unsubscribe = opts.onSubscribe((batch) => {
        // ServerWritableStream.write returns a boolean for backpressure
        // signalling. v1 ignores it — slow-client policy is M4. The
        // stream's internal queue absorbs short bursts.
        call.write(batch);
      });
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
