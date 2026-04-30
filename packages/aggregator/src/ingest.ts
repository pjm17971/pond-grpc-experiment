import { performance } from 'node:perf_hooks';
import { credentials, type ChannelCredentials } from '@grpc/grpc-js';
import type { RowForSchema } from 'pond-ts/types';
import { type LiveSeries } from 'pond-ts';
import { backoff, type Schema } from '@pond-experiment/shared';
import { ProducerClient, SubscribeRequest } from '@pond-experiment/shared/grpc';
import { recordIngest, recordPushMany } from './metrics.js';

type IngestRow = RowForSchema<Schema>;

export type IngestOptions = {
  /** Producer address, e.g. `localhost:50051`. */
  producerUrl: string;
  /** Optional override; defaults to insecure (M2 is plaintext, TLS is M6). */
  channelCredentials?: ChannelCredentials;
};

/**
 * Dial the producer's `Subscribe` RPC and pump every `EventBatch`'s
 * events into the local `LiveSeries`. On stream end / error,
 * reconnect with shared exponential backoff. Returns a stop()
 * function that cancels any in-flight stream and prevents further
 * reconnects.
 *
 * Each gRPC frame carries one `EventBatch`; the aggregator unpacks
 * it into one `pushMany` call. The setImmediate-coalescer the M3
 * baseline ingest used is gone — the wire IS the batch.
 */
export function startIngest(
  live: LiveSeries<Schema>,
  opts: IngestOptions,
): () => void {
  const creds = opts.channelCredentials ?? credentials.createInsecure();
  const client = new ProducerClient(opts.producerUrl, creds);

  let cancelled = false;
  let attempt = 0;
  let activeCall: ReturnType<ProducerClient['subscribe']> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const connect = () => {
    if (cancelled) return;
    const call = client.subscribe(SubscribeRequest.create());
    activeCall = call;
    // Reset the backoff counter once per stream, on the first
    // delivered frame. Resetting on every frame would make a stream
    // that opens-delivers-drops repeatedly look healthy in logs and
    // perpetually retry on the 1s base delay. A "stable for N
    // seconds before reset" rule would be more robust under chronic
    // flapping; deferring the design call to M3.
    let firstFrame = true;

    call.on('data', (batch) => {
      if (firstFrame) {
        attempt = 0;
        firstFrame = false;
      }
      const events = batch.events;
      const rows: IngestRow[] = new Array(events.length);
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        recordIngest(event.host, event.timeMs);
        rows[i] = [
          new Date(event.timeMs),
          event.cpu,
          event.requests,
          event.host,
        ];
      }
      if (rows.length > 0) {
        const t0 = performance.now();
        live.pushMany(rows);
        const totalMs = performance.now() - t0;
        recordPushMany(rows.length, totalMs);
      }
    });

    const onEnd = (err?: Error) => {
      if (activeCall !== call) return; // already replaced
      activeCall = null;
      if (cancelled) return;
      const delay = backoff(attempt);
      attempt += 1;
      if (err) {
        console.warn(
          `gRPC stream closed: ${err.message}. Reconnecting in ${delay}ms (attempt ${attempt}).`,
        );
      } else {
        console.warn(`gRPC stream closed cleanly. Reconnecting in ${delay}ms.`);
      }
      reconnectTimer = setTimeout(connect, delay);
    };

    call.on('end', () => onEnd());
    call.on('error', (err: Error) => onEnd(err));
  };

  connect();

  return () => {
    cancelled = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    activeCall?.cancel();
    client.close();
  };
}
