import { HOSTS } from '@pond-experiment/shared';
import type { Event } from '@pond-experiment/shared/grpc';

/**
 * Per-host CPU baseline. Each host gets a distinct mean so the chart
 * shows separable lines under bands. Lifted from the M1 aggregator;
 * lives here in M2 because the producer owns the simulator.
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
 * Generate synthetic metric events on a setInterval. Each tick emits
 * one Event per active host through the `onEvent` callback. Returns
 * a stop() function. Per-host timestamps are staggered inside the
 * tick (1ms slot up to `tickMs / hostCount`) so events don't collide
 * on the LiveSeries time key on the consumer side — see
 * friction-notes/M1.md "count collapses same-ts events".
 */
export function startSimulator(
  opts: SimulatorOptions,
  onEvent: (event: Event) => void,
): () => void {
  const tickMs = 1000 / opts.eventsPerSec;
  const id = setInterval(() => {
    const baseT = Date.now();
    const n = Math.min(opts.hostCount, HOSTS.length);
    const slotMs = Math.max(1, Math.floor(tickMs / Math.max(n, 1)));
    for (let i = 0; i < n; i++) {
      const mean = HOST_MEANS[i % HOST_MEANS.length];
      const cpu = Math.max(
        0,
        Math.min(1, mean + (Math.random() - 0.5) * opts.variability),
      );
      onEvent({
        timeMs: baseT + i * slotMs,
        cpu,
        requests: Math.floor(Math.random() * 200),
        host: HOSTS[i],
      });
    }
  }, tickMs);
  return () => clearInterval(id);
}
