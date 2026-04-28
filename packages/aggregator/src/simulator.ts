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
    for (let i = 0; i < n; i++) {
      const mean = HOST_MEANS[i % HOST_MEANS.length];
      const cpu = Math.max(
        0,
        Math.min(1, mean + (Math.random() - 0.5) * opts.variability),
      );
      // Stagger per-host timestamps within a tick by 1ms each so
      // same-tick events don't collide on the LiveSeries' time key.
      // Friction note: pond's `count` collapsed same-ts events,
      // making EVENT RATE under-report by hostCount.
      live.push([
        new Date(baseT + i),
        cpu,
        Math.floor(Math.random() * 200),
        HOSTS[i],
      ]);
    }
  }, tickMs);
  return () => clearInterval(id);
}
