export type BackoffOptions = {
  /** First-attempt delay, in ms. Default 1000. */
  initialMs?: number;
  /** Cap on the exponential growth, in ms. Default 30000. */
  maxMs?: number;
  /** Symmetric jitter as a fraction of the un-jittered delay (0–1). Default 0.2 (±20%). */
  jitter?: number;
};

/**
 * Exponential backoff with jitter. Returns the delay (in ms) the
 * caller should wait before retry attempt `attempt` (0-indexed:
 * `attempt = 0` is the first retry after the initial failure).
 *
 * Two M2 callers share this helper:
 * - aggregator's gRPC reconnect to the producer
 * - web's `useRemoteLiveSeries` WS reconnect to the aggregator
 *
 * Defaults give 1s → 2s → 4s → 8s → 16s → 30s (cap), each with ±20%
 * jitter so a reconnect storm doesn't synchronise. Friction note for
 * the eventual `@pond-ts/server` extraction: this primitive belongs
 * in the library alongside the snapshot/append surface.
 */
export function backoff(attempt: number, options: BackoffOptions = {}): number {
  const initial = options.initialMs ?? 1000;
  const max = options.maxMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;
  const base = Math.min(max, initial * 2 ** attempt);
  const spread = base * jitter;
  return Math.round(base + (Math.random() * 2 - 1) * spread);
}
