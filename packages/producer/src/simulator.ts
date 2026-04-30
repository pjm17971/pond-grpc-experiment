import { HOSTS } from '@pond-experiment/shared';
import type { Event } from '@pond-experiment/shared/grpc';

/**
 * Per-host CPU baseline. Each host gets a distinct mean so the chart
 * shows separable lines under bands. The first 8 entries match the
 * canonical `HOSTS` palette; beyond that we cycle the means so any
 * `hostCount` (M3 bench goes up to 1000) gets stable per-host
 * baselines.
 */
const HOST_MEANS: readonly number[] = [
  0.55, 0.45, 0.65, 0.5, 0.6, 0.4, 0.7, 0.35,
];

/**
 * Resolve the host name at index `i`. Indexes < `HOSTS.length` use
 * the canonical names so the dashboard's host-toggle UI keeps
 * working at default scales; indexes ≥ `HOSTS.length` synthesise
 * `api-${i+1}`. M3 bench parameterises `hostCount` up to 1000.
 */
function hostNameAt(i: number): string {
  return i < HOSTS.length ? HOSTS[i] : `api-${i + 1}`;
}

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
 * one Event per host through the `onEvent` callback, all sharing the
 * tick's `Date.now()` timestamp.
 *
 * M1 staggered per-host timestamps inside the tick to dodge a
 * misdiagnosed `count()` collapse. The pond-ts 0.11.6 docs clarified
 * that same-`Time` events do **not** collapse — they each contribute
 * to count, reduce, etc. independently. Removing the stagger:
 *  - lets the simulator scale past M3 stress rates (at 1ms
 *    `tickMs` the staggered offsets `[0..n-1]ms` would bleed into
 *    the next tick and trigger `out-of-order` ValidationError on
 *    the consumer side);
 *  - simplifies the timeline (one wall-clock ms per tick).
 *
 * Across ticks, timestamps are monotonically non-decreasing because
 * `Date.now()` is monotonic. Pond's `ordering: 'strict'` (default)
 * accepts equal timestamps but rejects strictly-earlier ones, so
 * the simulator stays compatible with the default mode.
 */
export function startSimulator(
  opts: SimulatorOptions,
  onEvent: (event: Event) => void,
): () => void {
  const tickMs = 1000 / opts.eventsPerSec;
  const id = setInterval(() => {
    const baseT = Date.now();
    const n = opts.hostCount;
    for (let i = 0; i < n; i++) {
      const mean = HOST_MEANS[i % HOST_MEANS.length];
      const cpu = Math.max(
        0,
        Math.min(1, mean + (Math.random() - 0.5) * opts.variability),
      );
      onEvent({
        timeMs: baseT,
        cpu,
        requests: Math.floor(Math.random() * 200),
        host: hostNameAt(i),
      });
    }
  }, tickMs);
  return () => clearInterval(id);
}
