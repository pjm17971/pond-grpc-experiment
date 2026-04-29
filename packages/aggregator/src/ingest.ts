import { credentials, type ChannelCredentials } from '@grpc/grpc-js';
import { type LiveSeries } from 'pond-ts';
import { backoff, type Schema } from '@pond-experiment/shared';
import { ProducerClient, SubscribeRequest } from '@pond-experiment/shared/grpc';

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

    call.on('data', (event) => {
      // Reset the backoff counter on a successful frame — a stream
      // that delivers data is healthy regardless of past failures.
      attempt = 0;
      live.push([
        new Date(event.timeMs),
        event.cpu,
        event.requests,
        event.host,
      ]);
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
