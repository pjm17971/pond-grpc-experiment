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
 * Dial the producer's `Subscribe` RPC and pump every Event into the
 * local LiveSeries. On stream end / error, reconnect with shared
 * exponential backoff. Returns a stop() function that cancels any
 * in-flight stream and prevents further reconnects.
 *
 * The aggregator is a pure relay in M2 — no local simulator. The
 * producer owns event generation; this function is the bridge from
 * the gRPC stream to pond's `LiveSeries.push`.
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

    // Per-stream macrotask-coalescing buffer. Every gRPC 'data'
    // event appends to `pending`; the first append per macrotask
    // schedules a `setImmediate` flush that pushes the whole batch
    // via `live.pushMany(rows)`. Coalescing collapses N synchronous
    // pond.push() calls into one pushMany() per event-loop tick —
    // M3 measurement showed this is ~3-5× the per-event regime at
    // saturation rates.
    let pending: IngestRow[] = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      recordPushMany(batch.length);
      live.pushMany(batch);
    };

    call.on('data', (event) => {
      if (firstFrame) {
        attempt = 0;
        firstFrame = false;
      }
      recordIngest(event.host, event.timeMs);
      pending.push([
        new Date(event.timeMs),
        event.cpu,
        event.requests,
        event.host,
      ]);
      if (!scheduled) {
        scheduled = true;
        setImmediate(flush);
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
