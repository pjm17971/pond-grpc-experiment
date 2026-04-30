import { type LiveSeries } from 'pond-ts';
import {
  type AggregateAppendMsg,
  type HostTick,
  type Schema,
  encode,
} from '@pond-experiment/shared';

/**
 * Rolling 1-minute window of CPU samples for one host. Stored as two
 * parallel `number[]`s (timestamps + values) so we can trim by time
 * without allocating a tuple per sample. `head` is the index of the
 * oldest live sample; entries below `head` are dead but not yet
 * compacted.
 *
 * We compact (`splice`) lazily — when at least 25% of the array is
 * dead — so the steady-state cost per push is amortised O(1) and we
 * avoid an array shift on every sample at high rates.
 */
type HostBuffer = {
  times: number[];
  values: number[];
  head: number;
  /** Count of samples that arrived since the last `tick()` call. */
  newSinceTick: number;
};

const WINDOW_MS = 60_000;
const COMPACT_THRESHOLD = 0.25;

/**
 * Per-host rolling-window aggregator. Wired to the aggregator's
 * `LiveSeries` via `live.on('batch', …)`: every event observed by the
 * fanout's batch listener also flows through `record()` here. On a
 * fixed 200ms tick a `HostTick` is emitted per host that has any
 * sample in the live window — silent hosts drop out of the frame.
 *
 * Step 1 of M3.5 computes mean and (population) standard deviation
 * over the rolling 1m window directly from the buffer. The full
 * `WIRE.md` shape (anomalies arrays at fixed σ thresholds, requests
 * stats, min/max) is staged in follow-up PRs.
 *
 * Computation is deliberately manual rather than driven through pond
 * (`partitionBy('host').baseline('cpu', { window: '1m' })`) for
 * step 1: pond's server-side partition+baseline-as-aggregate API
 * isn't surfaced for tick-driven sampling yet, and rolling here keeps
 * the wire-format work decoupled from a library RFC. See
 * `friction-notes/M3.5.md` for the API gap that drives the M5 sweep.
 */
export class HostAggregator {
  private readonly buffers = new Map<string, HostBuffer>();

  /** Called once per CPU sample observed in the fanout's batch listener. */
  record(host: string, sampleTimeMs: number, cpu: number): void {
    let buf = this.buffers.get(host);
    if (!buf) {
      buf = { times: [], values: [], head: 0, newSinceTick: 0 };
      this.buffers.set(host, buf);
    }
    buf.times.push(sampleTimeMs);
    buf.values.push(cpu);
    buf.newSinceTick += 1;
  }

  /**
   * Snapshot every host's window at tick time. `tickTimeMs` is the
   * wall-clock used both as the emitted `ts` (so the dashboard
   * receives a synchronized clock across all host frames) and as the
   * trim cutoff (`tickTimeMs - 60s`). Resets the per-host
   * `newSinceTick` counter so the next tick measures the next window.
   */
  tick(tickTimeMs: number): HostTick[] {
    const cutoff = tickTimeMs - WINDOW_MS;
    const rows: HostTick[] = [];

    for (const [host, buf] of this.buffers) {
      // Advance head past anything older than the cutoff.
      while (buf.head < buf.times.length && buf.times[buf.head] < cutoff) {
        buf.head += 1;
      }
      // Compact when the dead prefix grows large enough — bounds the
      // unsplice cost without paying it on every push.
      const liveCount = buf.times.length - buf.head;
      if (
        buf.head > 0 &&
        buf.head / buf.times.length >= COMPACT_THRESHOLD
      ) {
        buf.times.splice(0, buf.head);
        buf.values.splice(0, buf.head);
        buf.head = 0;
      }

      const cpu_n = buf.newSinceTick;
      buf.newSinceTick = 0;

      if (liveCount === 0) {
        // Silent host this minute — drop the row entirely (the client
        // renders a gap until the host re-appears).
        continue;
      }

      let sum = 0;
      for (let i = buf.head; i < buf.times.length; i++) {
        sum += buf.values[i];
      }
      const mean = sum / liveCount;
      let sqSum = 0;
      for (let i = buf.head; i < buf.times.length; i++) {
        const d = buf.values[i] - mean;
        sqSum += d * d;
      }
      const sd = Math.sqrt(sqSum / liveCount);

      rows.push({
        ts: tickTimeMs,
        host,
        cpu_avg: mean,
        cpu_sd: sd,
        cpu_n,
      });
    }

    return rows;
  }

  /**
   * Drop the per-host buffer entirely. Used by the GC sweep when a
   * host has been silent for long enough that we don't even want it
   * occupying a key in the map. Step 1 doesn't run a sweep; left as
   * an explicit primitive for follow-up work.
   */
  forget(host: string): void {
    this.buffers.delete(host);
  }

  /** Test-only — number of hosts currently tracked. */
  get hostCount(): number {
    return this.buffers.size;
  }
}

export type AggregateOptions = {
  /** Tick cadence in milliseconds. WIRE.md target is 200ms. */
  tickMs?: number;
};

/**
 * Subscribe to the live series's batch fire, feed CPU samples into a
 * `HostAggregator`, and emit one `aggregate-append` frame per tick on
 * the supplied broadcast callback. Returns a `stop()` that disconnects
 * both the listener and the tick interval.
 *
 * Tick clock is `Date.now()` rounded down to the nearest tick boundary
 * — gives every frame in a tick the same `ts` regardless of when the
 * `setInterval` callback actually fires (which jitters under load).
 *
 * The aggregator process is the single producer of ticks; all clients
 * connected to `/live-agg` receive the same frame.
 */
export function startAggregate(
  live: LiveSeries<Schema>,
  broadcast: (frame: string) => void,
  opts: AggregateOptions = {},
): { stop: () => void; aggregator: HostAggregator } {
  const tickMs = opts.tickMs ?? 200;
  const aggregator = new HostAggregator();

  const unsubscribe = live.on('batch', (events) => {
    for (const e of events) {
      aggregator.record(e.get('host'), e.key().timestampMs(), e.get('cpu'));
    }
  });

  const interval = setInterval(() => {
    const tickTimeMs = Math.floor(Date.now() / tickMs) * tickMs;
    const rows = aggregator.tick(tickTimeMs);
    if (rows.length === 0) return;
    const msg: AggregateAppendMsg = { type: 'aggregate-append', rows };
    broadcast(encode(msg));
  }, tickMs);
  // Don't keep the event loop alive on shutdown; the explicit stop()
  // is the supported teardown.
  interval.unref();

  return {
    aggregator,
    stop: () => {
      clearInterval(interval);
      unsubscribe();
    },
  };
}
