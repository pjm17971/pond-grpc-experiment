/**
 * Seeded RNG utilities shared across the producer's randomised
 * subsystems (the simulator's CPU/burst/requests noise + the late-
 * event injector's selection / delay sampling).
 *
 * The friction note's drift-comparison harness needs **both** the
 * simulator AND the late-injector to be reproducible across
 * replicates — otherwise the A/B legs see different underlying
 * workloads and the run-to-run noise floor absorbs uncontrolled
 * `Math.random()` variance instead of just tick-scheduling jitter.
 * Codex review of PR #41 caught the gap: replicate seeds were
 * threaded through the late-injector but not the simulator, so the
 * "noise floor" baseline was inflated by simulator randomness.
 *
 * Module-level (not class) so callsites stay terse — `const rng =
 * mulberry32(seed); rng()` reads the same as `Math.random()`.
 */

/**
 * Mulberry32 — small, fast, decent-quality 32-bit RNG. Produces
 * `[0, 1)` uniformly. Seedable + deterministic, which is what the
 * milestone-B brief requires for reproducible runs.
 *
 * Reference: https://stackoverflow.com/a/47593316
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
