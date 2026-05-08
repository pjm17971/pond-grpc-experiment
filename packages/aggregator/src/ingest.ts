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
  /**
   * **Prototype** — stride-sampling factor before `live.pushMany`.
   * Defaults to 1 (push every event, current behaviour). When set
   * to N > 1, only every Nth event from the gRPC stream lands in
   * the LiveSeries; the rolling state and listener fan-out
   * downstream see N× fewer events.
   *
   * This is the experiment's user-space stand-in for the
   * `live.partitionBy(...).sample({ stride: N })` library primitive
   * proposed in the M3.5 friction note. The math says rolling
   * `cpu_avg` / `cpu_sd` are visually identical at sample rates
   * below 1-in-100 (standard error of the mean grows √N but stays
   * orders of magnitude below per-event noise at firehose).
   *
   * Caveat for this prototype: counts post-sample, so the wire's
   * reported `events_ingested_total` and `events_per_sec` reflect
   * the **observed** count rather than the true gRPC firehose. A
   * real implementation would track a separate true-ingest
   * counter at the gRPC layer (before the stride) and surface
   * both `count_observed` and `count_total`. Keep that in mind
   * when reading the dashboard's headline numbers under
   * `SAMPLE_STRIDE > 1`.
   */
  sampleStride?: number;
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
  const sampleStride = Math.max(1, Math.floor(opts.sampleStride ?? 1));
  // Per-host stride counters. A *global* stride counter would bias
  // when the input stream has structure: this experiment's producer
  // emits one event per host per tick in a fixed host order, so a
  // single shared counter at stride=10 keeps the same 8 hosts from
  // every batch and drops the other 72 entirely. Per-host stride
  // gives each host a uniform 1/N effective rate, which is what the
  // proposed library primitive (`partitionBy(...).sample(...)`)
  // does naturally — chaining after `partitionBy` thins per-stream.
  // For the prototype we don't have pond's partitioning available
  // before pushMany, so we maintain the per-host counters in a
  // small Map and look them up by host on each event.
  const sampleCounters = sampleStride > 1 ? new Map<string, number>() : null;

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
      const rows: IngestRow[] = [];
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        recordIngest(event.host, event.timeMs);
        // Per-host stride sampling. `sampleStride === 1` is the
        // no-op path (every event passes; same shape as pre-
        // prototype). At stride > 1 we keep one in N per host —
        // each host's counter ticks independently, so every host
        // gets a uniform 1/N effective rate even when the producer
        // emits events in a fixed host order across batches. See
        // the counter declaration above for why a global counter
        // is wrong in this experiment.
        let pass = true;
        if (sampleCounters !== null) {
          const host = event.host;
          const c = sampleCounters.get(host) ?? 0;
          pass = c % sampleStride === 0;
          sampleCounters.set(host, c + 1);
        }
        if (pass) {
          rows.push([
            new Date(event.timeMs),
            event.cpu,
            event.requests,
            event.host,
          ]);
        }
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
