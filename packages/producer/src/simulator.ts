import { HOSTS } from '@pond-experiment/shared';
import type { Event, EventBatch } from '@pond-experiment/shared/grpc';

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
 * one Event per host, packaged into a single `EventBatch` and
 * delivered through the `onBatch` callback. The producer's gRPC
 * Subscribe stream forwards each batch as one frame.
 *
 * Per-tick batching closes the per-event gRPC bottleneck observed
 * in M3 (avg coalesced batch was 1.4 events on the consumer side
 * because gRPC delivers events one per event-loop tick). With
 * EventBatch the wire IS the batch — at P=100 each frame carries
 * ~100 events, which matches library-bench territory for `pushMany`.
 *
 * Across ticks, timestamps are monotonically non-decreasing
 * (`Date.now()` is monotonic). Pond's `ordering: 'strict'` (default)
 * accepts equal timestamps but rejects strictly-earlier ones, so
 * same-tick events sharing one `Date.now()` ms are fine — they each
 * contribute independently to `count`, `reduce`, etc. (clarified in
 * pond-ts 0.11.6 docs).
 */
export function startSimulator(
  opts: SimulatorOptions,
  onBatch: (batch: EventBatch) => void,
): () => void {
  const tickMs = 1000 / opts.eventsPerSec;
  const id = setInterval(() => {
    const baseT = Date.now();
    const n = opts.hostCount;
    const events: Event[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const mean = HOST_MEANS[i % HOST_MEANS.length];
      const cpu = Math.max(
        0,
        Math.min(1, mean + (Math.random() - 0.5) * opts.variability),
      );
      events[i] = {
        timeMs: baseT,
        cpu,
        requests: Math.floor(Math.random() * 200),
        host: hostNameAt(i),
      };
    }
    onBatch({ events });
  }, tickMs);
  return () => clearInterval(id);
}
