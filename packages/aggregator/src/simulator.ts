import { type LiveSeries } from 'pond-ts';
import { HOSTS, type Schema } from '@pond-experiment/shared';

/**
 * Per-host CPU baseline. Each host gets a distinct mean so the chart
 * shows separable lines under bands. M1 keeps these aggregator-local
 * (simulator-internal). M2 will move them to the producer package.
 */
const HOST_MEANS: readonly number[] = [
  0.55, 0.45, 0.65, 0.5, 0.6, 0.4, 0.7, 0.35,
];

export type SimulatorOptions = {
  /** Tick rate in events per second across the active host slice. */
  eventsPerSec: number;
  /** Number of hosts the simulator generates events for. */
  hostCount: number;
  /** Width of the random ±range around each host's mean CPU. */
  variability: number;
};

/**
 * Push synthetic metrics into a `LiveSeries` on a setInterval. Returns
 * a stop() function. Lifted from the M0 web `useSimulator`; the only
 * structural change is the React hook → plain function.
 */
export function startSimulator(
  live: LiveSeries<Schema>,
  opts: SimulatorOptions,
): () => void {
  const tickMs = 1000 / opts.eventsPerSec;
  const id = setInterval(() => {
    const baseT = Date.now();
    const n = Math.min(opts.hostCount, HOSTS.length);
    // Stagger per-host timestamps inside the tick so same-tick events
    // don't share a time key (pond's `count` collapses same-ts events,
    // friction-noted). Cap the per-host slot at `tickMs / n` so the
    // last host's offset stays inside (baseT, baseT + tickMs) and
    // can't bleed into the next tick.
    //
    // At M3-territory rates (eventsPerSec >> 100) the slot rounds
    // down to 0 and we re-clamp to 1ms, at which point overlapping
    // ticks become unavoidable at ms resolution. M3 will need a
    // proper sub-ms path (Time instances or microsecond counters).
    const slotMs = Math.max(1, Math.floor(tickMs / Math.max(n, 1)));
    for (let i = 0; i < n; i++) {
      const mean = HOST_MEANS[i % HOST_MEANS.length];
      const cpu = Math.max(
        0,
        Math.min(1, mean + (Math.random() - 0.5) * opts.variability),
      );
      live.push([
        new Date(baseT + i * slotMs),
        cpu,
        Math.floor(Math.random() * 200),
        HOSTS[i],
      ]);
    }
  }, tickMs);
  return () => clearInterval(id);
}
