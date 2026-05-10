import { HOSTS } from '@pond-experiment/shared';
import type { Event, EventBatch } from '@pond-experiment/shared/grpc';
import { mulberry32 } from './rng.js';

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
  /**
   * Optional RNG seed for the simulator's randomised state — CPU
   * walk noise, anomaly bursts, per-event noise, and `requests`
   * count. When provided, the simulator uses `mulberry32(seed)`
   * instead of `Math.random()`, so two runs at the same seed
   * produce identical event streams.
   *
   * Drives milestone-B's drift-comparison harness: the late-data
   * driver needs the A/B legs to share the **same underlying
   * workload** (only the late-injection layer differs between
   * legs), otherwise baseline variance absorbs uncontrolled
   * simulator noise and the noise-floor estimate is inflated.
   * Codex review of PR #41 caught this — pre-fix, replicate
   * seeds only seeded the late-injector and the simulator's
   * `Math.random()` calls drifted independently across replicates.
   *
   * `undefined` (the default) keeps `Math.random()` for the
   * dashboard / dev / bench paths where reproducibility isn't a
   * goal.
   */
  seed?: number;
};

/**
 * Generate synthetic metric events on a setInterval. Each tick emits
 * one Event per host, packaged into a single `EventBatch` and
 * delivered through the `onBatch` callback. The producer's gRPC
 * Subscribe stream forwards each batch as one frame.
 *
 * **Time-domain dynamics.** Each host's CPU value combines three
 * sources of variation:
 *   1. A static per-host baseline (`HOST_MEANS[h]`) for separable
 *      chart lines under bands.
 *   2. A slow mean-reverting random walk on top of (1), updated
 *      once per wall-clock second regardless of tick rate. Visible
 *      on the dashboard's smoothed line as gentle minute-scale
 *      drift — without it, high-rate dashboards collapse to flat
 *      lines because the 1m smoothing averages out per-event noise
 *      completely.
 *   3. Occasional anomaly bursts (~2% chance/host/sec) that elevate
 *      the host's CPU by `BURST_AMP` for `BURST_DURATION_MS`. These
 *      populate the dashboard's anomaly counters / 15s bar chart so
 *      the σ-slider has something to interpolate against.
 *   4. Per-event Gaussian-ish noise (existing) of width `variability`.
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

/**
 * Slow random-walk parameters. Walk steps once per
 * `WALK_INTERVAL_MS` (independent of tick rate so a 50k/s simulator
 * doesn't drift 1000× faster than a 50/s one). Mean-reverting toward
 * each host's static baseline so the chart line wanders but doesn't
 * runaway-drift over hours of simulation.
 */
const WALK_INTERVAL_MS = 1000;
/** Pull-back-to-baseline coefficient per second of elapsed time. */
const WALK_REVERSION = 0.15;
/** Std of per-second random-walk drift step. */
const WALK_DRIFT = 0.025;
/** Hard clamp on the walking baseline (per-event noise can still push outside [0,1]). */
const WALK_LO = 0.15;
const WALK_HI = 0.9;

/**
 * Anomaly-burst parameters. A burst is a `BURST_DURATION_MS`-long
 * interval where the host's CPU is elevated by `BURST_AMP`. Tuned so
 * bursts trigger 1–2σ anomalies under default `VARIABILITY=0.4` —
 * enough to populate the dashboard's anomaly counters + bar chart
 * without saturating the high-σ buckets.
 */
const BURST_PROB_PER_SEC = 0.02;
const BURST_AMP = 0.25;
const BURST_DURATION_MS = 4_000;

export function startSimulator(
  opts: SimulatorOptions,
  onBatch: (batch: EventBatch) => void,
): () => void {
  const tickMs = 1000 / opts.eventsPerSec;
  const n = opts.hostCount;
  // Use a seeded RNG when provided (drift-harness reproducibility);
  // otherwise pass through `Math.random` for the dashboard / bench
  // paths where reproducibility isn't a goal.
  const random = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;

  // Per-host dynamic state. `hostMeans[i]` is host i's current
  // walking baseline; `burstEndMs[i]` is the wall-clock at which the
  // active anomaly burst ends (0 = no active burst).
  const hostMeans = new Array<number>(n);
  const burstEndMs = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    hostMeans[i] = HOST_MEANS[i % HOST_MEANS.length];
    burstEndMs[i] = 0;
  }
  let lastWalkMs = Date.now();

  const id = setInterval(() => {
    const baseT = Date.now();

    // Time-domain walk + anomaly-burst seeding, throttled to once
    // per `WALK_INTERVAL_MS` so the per-second drift/burst rates are
    // independent of `eventsPerSec`.
    if (baseT - lastWalkMs >= WALK_INTERVAL_MS) {
      const elapsedSec = (baseT - lastWalkMs) / 1000;
      lastWalkMs = baseT;
      for (let i = 0; i < n; i++) {
        const baseline = HOST_MEANS[i % HOST_MEANS.length];
        const reversion =
          WALK_REVERSION * elapsedSec * (baseline - hostMeans[i]);
        // Triangular-distribution approximation of a normal step
        // (mean 0, sd ~WALK_DRIFT * sqrt(elapsedSec)). Two-uniform
        // average is good enough for visual texture; the dashboard
        // doesn't care about the higher moments.
        const noise =
          (random() - 0.5 + (random() - 0.5)) *
          WALK_DRIFT *
          Math.sqrt(elapsedSec);
        hostMeans[i] = Math.max(
          WALK_LO,
          Math.min(WALK_HI, hostMeans[i] + reversion + noise),
        );
        // Seed an anomaly burst if not already in one. Probability
        // scales with elapsed time so longer pauses don't suppress
        // bursts.
        if (
          baseT >= burstEndMs[i] &&
          random() < BURST_PROB_PER_SEC * elapsedSec
        ) {
          burstEndMs[i] = baseT + BURST_DURATION_MS;
        }
      }
    }

    const events: Event[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const dynamic = hostMeans[i];
      const burst = baseT < burstEndMs[i] ? BURST_AMP : 0;
      const cpu = Math.max(
        0,
        Math.min(
          1,
          dynamic + burst + (random() - 0.5) * opts.variability,
        ),
      );
      events[i] = {
        timeMs: baseT,
        cpu,
        requests: Math.floor(random() * 200),
        host: hostNameAt(i),
      };
    }
    onBatch({ events });
  }, tickMs);
  return () => clearInterval(id);
}
