import { describe, it, expect } from 'vitest';
import { countAtSigma } from './anomalyInterpolation';

const thresholds = [1, 1.5, 2, 2.5, 3] as const;

describe('countAtSigma', () => {
  it('linearly interpolates between buckets — WIRE.md worked example', () => {
    const counts = [876, 62, 12, 1, 0];
    // σ=1.25, halfway between thresholds[0]=1 and thresholds[1]=1.5
    // → 876 + (62 - 876) * 0.5 = 876 - 407 = 469
    expect(countAtSigma(counts, 1.25, thresholds)).toBeCloseTo(469, 0);
  });

  it('returns the first count for σ at or below the lowest threshold', () => {
    const counts = [100, 50, 25, 10, 5];
    expect(countAtSigma(counts, 1, thresholds)).toBe(100);
    expect(countAtSigma(counts, 0.5, thresholds)).toBe(100);
    expect(countAtSigma(counts, 0, thresholds)).toBe(100);
  });

  it('returns the last count for σ at or above the highest threshold', () => {
    const counts = [100, 50, 25, 10, 5];
    expect(countAtSigma(counts, 3, thresholds)).toBe(5);
    expect(countAtSigma(counts, 3.5, thresholds)).toBe(5);
    expect(countAtSigma(counts, 10, thresholds)).toBe(5);
  });

  it('hits exact bucket values at threshold boundaries', () => {
    const counts = [100, 50, 25, 10, 5];
    expect(countAtSigma(counts, 1.5, thresholds)).toBe(50);
    expect(countAtSigma(counts, 2.0, thresholds)).toBe(25);
    expect(countAtSigma(counts, 2.5, thresholds)).toBe(10);
  });

  it('interpolates fractionally inside a bucket', () => {
    const counts = [100, 50, 25, 10, 5];
    // σ=1.75, 50% between thresholds[1]=1.5 and thresholds[2]=2
    // → 50 + (25 - 50) * 0.5 = 37.5
    expect(countAtSigma(counts, 1.75, thresholds)).toBeCloseTo(37.5, 6);
    // σ=2.25, 50% between thresholds[2]=2 and thresholds[3]=2.5
    // → 25 + (10 - 25) * 0.5 = 17.5
    expect(countAtSigma(counts, 2.25, thresholds)).toBeCloseTo(17.5, 6);
  });

  it('returns 0 for empty arrays (gating signal)', () => {
    expect(countAtSigma([], 2, thresholds)).toBe(0);
    expect(countAtSigma([1, 2, 3, 4, 5], 2, [])).toBe(0);
  });

  it('returns 0 on length mismatch (defensive against wire-shape drift)', () => {
    expect(countAtSigma([1, 2, 3], 2, thresholds)).toBe(0);
    expect(countAtSigma([1, 2, 3, 4, 5, 6], 2, thresholds)).toBe(0);
  });

  it('handles all-zero counts (no anomalies in any bucket)', () => {
    expect(countAtSigma([0, 0, 0, 0, 0], 2, thresholds)).toBe(0);
    expect(countAtSigma([0, 0, 0, 0, 0], 1.75, thresholds)).toBe(0);
  });
});
