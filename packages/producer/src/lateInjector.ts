/**
 * Controlled late-event injection at the gRPC producer.
 *
 * Wraps the simulator's `onBatch` callback. For each generated event,
 * with probability `fraction` (plus optional per-host bias) the event
 * is held in a side-channel queue and emitted later, after a delay
 * drawn from a log-normal distribution (median = `delayMeanMs`,
 * p99 = `delayTailMs`). The held event's `timeMs` is unchanged —
 * that's what makes it "late": it arrives at the aggregator with a
 * `time` field that's in the past relative to events the aggregator
 * has already ingested.
 *
 * Background: this is the late-event-driver work for pond-ts's
 * milestone B (capability-based late repair). See
 * `pond-ts/docs/briefs/grpc-late-data-validation.md`.
 *
 * **Reproducibility.** RNG is seeded (mulberry32) so two runs of the
 * same workload produce identical results. The brief explicitly
 * requires this — drift comparisons between clean-baseline and
 * late-loaded runs are noise without it.
 *
 * **Counters.** Tracks `events_emitted_total`, `events_emitted_late_total`,
 * and a reservoir of recent lateness samples for percentile readout
 * (p50, p99). Exposed via the producer's `/metrics` HTTP endpoint
 * so the bench harness can read them post-run for the friction-note
 * ground truth.
 */

import type { Event, EventBatch } from '@pond-experiment/shared/grpc';
import { mulberry32 } from './rng.js';

export type LateInjectorOptions = {
  /** 0..1 — base probability that any given event is held as late. */
  fraction: number;
  /** Median delay (ms). Log-normal scale parameter `μ = ln(this)`. */
  delayMeanMs: number;
  /**
   * 99th-percentile delay (ms). Together with `delayMeanMs`,
   * determines the log-normal `σ` such that `p99 = exp(μ + 2.326σ)`.
   * Must be ≥ `delayMeanMs`.
   */
  delayTailMs: number;
  /**
   * Per-host extra fraction. Adds to the base `fraction` for the
   * named host. Example: `{ 'api-3': 0.05 }` makes api-3 5% more
   * likely to emit late than other hosts.
   *
   * The point of host bias is to drive measurable drift between
   * clean-baseline and late-loaded runs: late events distributed
   * uniformly across hosts cancel out in `cpu_avg` (i.i.d. samples),
   * but biased late events shift specific hosts' rolling means by
   * an amount that depends on whether pond's rolling repairs them
   * (it doesn't, today). The friction note's payoff scenario is
   * exactly the biased case.
   */
  hostBias?: Readonly<Record<string, number>>;
  /** RNG seed (any integer). Different seeds produce independent runs. */
  seed: number;
};

export type LateInjectorMetrics = {
  events_emitted_total: number;
  events_emitted_late_total: number;
  /** p50 of the lateness reservoir (ms), or 0 if no late events yet. */
  lateness_p50_ms: number;
  /** p99 of the lateness reservoir (ms), or 0 if no late events yet. */
  lateness_p99_ms: number;
  /** Reservoir size — useful for sanity-checking the percentiles. */
  lateness_samples_count: number;
};

/**
 * Sample one delay from a log-normal distribution parameterised by
 * `(median, p99)`. Uses Box-Muller to draw a standard normal, then
 * applies the inverse-log transform. Works because for X ~
 * LogNormal(μ, σ): median = exp(μ), p99 = exp(μ + 2.326σ).
 */
function sampleLogNormal(
  rng: () => number,
  median: number,
  p99: number,
): number {
  const mu = Math.log(median);
  const sigma = Math.max(0, (Math.log(p99) - mu) / 2.326);
  // Avoid log(0) at the U(0,1) boundary.
  const u1 = Math.max(1e-10, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}

/**
 * Quickselect-based percentile. Mutates a shallow copy of the
 * reservoir so the callsite's array is unchanged. Rounds to integer
 * ms (lateness is presented as ms in the friction note).
 */
function percentile(samples: ReadonlyArray<number>, p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[idx]);
}

const RESERVOIR_CAPACITY = 1000;

export type LateInjector = {
  /** Drop-in replacement for the simulator's `onBatch` callback. */
  wrappedOnBatch: (batch: EventBatch) => void;
  /** Snapshot of the current counters (returns a fresh object each call). */
  metrics: () => LateInjectorMetrics;
  /**
   * Cancel any pending late-event timers. Call on shutdown so the
   * process can exit cleanly. Does NOT emit pending events — they
   * are dropped silently. For "drain-then-stop" semantics that
   * tighten the conservation check (every emitted late event makes
   * it onto the wire before the process exits), use `drain()` first.
   */
  stop: () => void;
  /**
   * Force every pending late event onto the wire **right now** by
   * synchronously firing all pending timers. Used by the bench /
   * drift harness on shutdown so the conservation check closes
   * exactly (`pond.ingested + throws + rejected == producer.emitted`)
   * rather than approximately. Without this, events whose
   * setTimeout hasn't fired at SIGTERM are silently dropped, and
   * the conservation check shows a few-percent drift purely from
   * the timer queue depth.
   *
   * After `drain()` returns, the timer queue is empty and the
   * `events_emitted_late_total` counter reflects every event that
   * was ever held. Safe to call concurrently with new pushes (the
   * inflight events still go through the normal late path); not
   * idempotent in the sense that pending timers are processed once
   * and only once.
   */
  drain: () => void;
};

/**
 * Wrap a downstream `onBatch` with the late-injection layer. For
 * each event in each incoming batch:
 *
 *   - Compute per-event late probability = `fraction + (hostBias[host] ?? 0)`.
 *   - With that probability, hold the event with a sampled delay.
 *   - Otherwise, emit it as part of the on-time batch.
 *
 * Held events are released via `setTimeout`; each release emits a
 * single-event batch through `downstream`. At realistic late rates
 * (~1% × ~16k events/s = ~160 timers/s) the timer load is fine.
 *
 * **Note on `time` field.** The held event's `timeMs` is its
 * **original** wall-clock-at-generation time, not the release time.
 * That's the whole point: at the aggregator, the event's `time` is
 * in the past relative to events that already arrived, which is
 * what late-data semantics mean.
 */
export function startLateInjector(
  downstream: (batch: EventBatch) => void,
  opts: LateInjectorOptions,
): LateInjector {
  const rng = mulberry32(opts.seed);
  const reservoir = new Array<number>(RESERVOIR_CAPACITY);
  let reservoirHead = 0;
  let reservoirCount = 0;
  let eventsEmittedTotal = 0;
  let eventsEmittedLateTotal = 0;
  /**
   * Each pending late-event entry: the timer handle (so `stop()` /
   * `drain()` can find it) plus the event payload (so `drain()` can
   * emit it without waiting for the timer to fire). Pre-drain this
   * was a `Set<Timeout>` — the payload was captured in the
   * setTimeout closure, opaque to drain().
   */
  type PendingEntry = {
    timer: ReturnType<typeof setTimeout>;
    event: Event;
  };
  const pendingEntries = new Set<PendingEntry>();
  let stopped = false;

  const recordLateness = (delayMs: number): void => {
    reservoir[reservoirHead] = delayMs;
    reservoirHead = (reservoirHead + 1) % RESERVOIR_CAPACITY;
    if (reservoirCount < RESERVOIR_CAPACITY) reservoirCount += 1;
  };

  const emitLateEvent = (event: Event): void => {
    if (stopped) return;
    eventsEmittedTotal += 1;
    eventsEmittedLateTotal += 1;
    downstream({ events: [event] });
  };

  const wrappedOnBatch = (batch: EventBatch): void => {
    if (stopped) return;
    const onTime: Event[] = [];
    for (const event of batch.events) {
      // Per-event late probability. Clamp at 1 so a user setting
      // fraction=0.5 with hostBias 0.6 doesn't produce a >1
      // probability that makes `rng() < p` always true (would still
      // technically work, but reads weird).
      const baseFrac = opts.fraction;
      const bias = opts.hostBias?.[event.host] ?? 0;
      const p = Math.max(0, Math.min(1, baseFrac + bias));
      if (p > 0 && rng() < p) {
        const delay = Math.max(
          0,
          sampleLogNormal(rng, opts.delayMeanMs, opts.delayTailMs),
        );
        recordLateness(delay);
        const entry: PendingEntry = {
          // Placeholder — overwritten on the next line. Avoids a
          // TDZ on `entry.timer` inside the setTimeout callback's
          // closure (which fires synchronously at delay=0 in some
          // test setups before the setTimeout return value lands).
          timer: undefined as unknown as ReturnType<typeof setTimeout>,
          event,
        };
        entry.timer = setTimeout(() => {
          pendingEntries.delete(entry);
          emitLateEvent(event);
        }, delay);
        pendingEntries.add(entry);
      } else {
        onTime.push(event);
      }
    }
    if (onTime.length > 0) {
      eventsEmittedTotal += onTime.length;
      downstream({ events: onTime });
    }
  };

  const metrics = (): LateInjectorMetrics => {
    const samples =
      reservoirCount === 0 ? [] : reservoir.slice(0, reservoirCount);
    return {
      events_emitted_total: eventsEmittedTotal,
      events_emitted_late_total: eventsEmittedLateTotal,
      lateness_p50_ms: percentile(samples, 0.5),
      lateness_p99_ms: percentile(samples, 0.99),
      lateness_samples_count: reservoirCount,
    };
  };

  const stop = (): void => {
    stopped = true;
    for (const entry of pendingEntries) clearTimeout(entry.timer);
    pendingEntries.clear();
  };

  /**
   * Synchronously fire every pending late event right now. Cancels
   * the underlying setTimeout (so it doesn't fire a second time),
   * then emits the event through the `emitLateEvent` path so the
   * counters tick exactly as they would have if the timer had
   * elapsed naturally.
   *
   * Snapshot the entries before iterating because `emitLateEvent`
   * is observable to the downstream — a downstream that calls
   * `drain()` recursively would mutate the set under iteration.
   * Today's downstream doesn't, but the snapshot is cheap defense.
   */
  const drain = (): void => {
    if (stopped) return;
    const snapshot = [...pendingEntries];
    pendingEntries.clear();
    for (const entry of snapshot) {
      clearTimeout(entry.timer);
      emitLateEvent(entry.event);
    }
  };

  return { wrappedOnBatch, metrics, stop, drain };
}

/**
 * Parse a `LATE_EVENT_HOST_BIAS` env value like `"api-3:0.05,api-7:0.1"`
 * into a `{ host: extraFraction }` map. Returns `undefined` if the
 * env value is empty / unset / unparseable.
 *
 * Defensive: a single malformed entry skips that entry silently
 * rather than failing the whole producer (env values are user-edited
 * strings; quietly defaulting beats a startup crash).
 */
export function parseHostBias(
  raw: string | undefined,
): Record<string, number> | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const [host, fracStr] = pair.split(':').map((s) => s.trim());
    if (!host || !fracStr) continue;
    const frac = Number(fracStr);
    if (!Number.isFinite(frac) || frac < -1 || frac > 1) continue;
    out[host] = frac;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
