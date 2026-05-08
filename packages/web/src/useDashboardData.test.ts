import { describe, it, expect } from 'vitest';
import type { HostTick } from '@pond-experiment/shared';
import {
  computeTotalReqPerSec,
  computeWeightedRollingCpu,
} from './useDashboardData';

/**
 * Build a `HostTick` with sane defaults; per-test overrides land on
 * top. Same shape as the synthetic ticks `useRemoteAggregateSeries`'
 * tests use, copied here to avoid coupling test files. Keep this in
 * sync with the wire shape.
 */
const mkTick = (overrides: Partial<HostTick>): HostTick => ({
  ts: 1_000,
  host: 'api-1',
  cpu_avg: 0.5,
  cpu_sd: 0.05,
  cpu_n: 100,
  n_current: 5,
  anomalies_above: [0, 0, 0, 0, 0],
  anomalies_below: [0, 0, 0, 0, 0],
  requests_avg: 100,
  requests_sum: 6_000,
  requests_n: 100,
  window_age_seconds: 60,
  cpu_min: 0.45,
  cpu_max: 0.55,
  ...overrides,
});

describe('computeWeightedRollingCpu', () => {
  it('returns undefined for an empty map', () => {
    expect(computeWeightedRollingCpu(new Map(), new Set(['api-1']))).toBeUndefined();
  });

  it('returns the host cpu_avg verbatim when only one host is enabled', () => {
    const m = new Map<string, HostTick>([
      ['api-1', mkTick({ host: 'api-1', cpu_avg: 0.42, cpu_n: 100 })],
    ]);
    expect(computeWeightedRollingCpu(m, new Set(['api-1']))).toBeCloseTo(
      0.42,
      6,
    );
  });

  it('weights by cpu_n — equal counts collapse to the unweighted mean', () => {
    const m = new Map<string, HostTick>([
      ['api-1', mkTick({ host: 'api-1', cpu_avg: 0.4, cpu_n: 100 })],
      ['api-2', mkTick({ host: 'api-2', cpu_avg: 0.6, cpu_n: 100 })],
    ]);
    expect(
      computeWeightedRollingCpu(m, new Set(['api-1', 'api-2'])),
    ).toBeCloseTo(0.5, 6);
  });

  it('weights by cpu_n — uneven counts pull the average toward the heavier host (Codex Finding 1)', () => {
    // High-volume host at 30% CPU + low-volume host at 90% CPU.
    // Naïve mean-of-means = 0.6, but the cluster is mostly the
    // high-volume host's traffic. Weighted average reflects that.
    const m = new Map<string, HostTick>([
      ['api-1', mkTick({ host: 'api-1', cpu_avg: 0.3, cpu_n: 1000 })],
      ['api-2', mkTick({ host: 'api-2', cpu_avg: 0.9, cpu_n: 10 })],
    ]);
    const enabled = new Set(['api-1', 'api-2']);
    // sum(cpu_avg × cpu_n) / sum(cpu_n) = (0.3×1000 + 0.9×10) / 1010
    //                                    = (300 + 9) / 1010 = 0.30594…
    expect(computeWeightedRollingCpu(m, enabled)).toBeCloseTo(0.30594, 4);
    // Sanity: the (broken) unweighted version would have returned 0.6.
    expect(computeWeightedRollingCpu(m, enabled)).not.toBeCloseTo(0.6, 2);
  });

  it('skips hosts not in the enabled set', () => {
    const m = new Map<string, HostTick>([
      ['api-1', mkTick({ host: 'api-1', cpu_avg: 0.1, cpu_n: 100 })],
      ['api-2', mkTick({ host: 'api-2', cpu_avg: 0.9, cpu_n: 100 })],
    ]);
    expect(
      computeWeightedRollingCpu(m, new Set(['api-2'])),
    ).toBeCloseTo(0.9, 6);
  });

  it('skips entries with null cpu_avg or zero cpu_n', () => {
    const m = new Map<string, HostTick>([
      // null cpu_avg (rolling window empty) — skip
      ['api-1', mkTick({ host: 'api-1', cpu_avg: null, cpu_n: 0 })],
      // cpu_n = 0 — skip even though cpu_avg is technically defined
      ['api-2', mkTick({ host: 'api-2', cpu_avg: 0.5, cpu_n: 0 })],
      // valid contributor
      ['api-3', mkTick({ host: 'api-3', cpu_avg: 0.7, cpu_n: 50 })],
    ]);
    expect(
      computeWeightedRollingCpu(m, new Set(['api-1', 'api-2', 'api-3'])),
    ).toBeCloseTo(0.7, 6);
  });

  it('returns undefined when every enabled host is filtered out', () => {
    const m = new Map<string, HostTick>([
      ['api-1', mkTick({ host: 'api-1', cpu_avg: null, cpu_n: 0 })],
    ]);
    expect(
      computeWeightedRollingCpu(m, new Set(['api-1'])),
    ).toBeUndefined();
  });
});

describe('computeTotalReqPerSec', () => {
  it('returns 0 when tEnd is undefined (no aggregate frame yet)', () => {
    const m = new Map<string, HostTick>([
      ['api-1', mkTick({ host: 'api-1', ts: 1_000 })],
    ]);
    expect(computeTotalReqPerSec(m, new Set(['api-1']), undefined)).toBe(0);
  });

  it('sums per-host rates from latestPerHost (requests_sum / window_age_seconds)', () => {
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd,
          requests_sum: 6_000,
          requests_n: 100,
          window_age_seconds: 60,
        }),
      ],
      [
        'api-2',
        mkTick({
          host: 'api-2',
          ts: tEnd,
          requests_sum: 12_000,
          requests_n: 200,
          window_age_seconds: 60,
        }),
      ],
    ]);
    // 6000/60 + 12000/60 = 100 + 200 = 300
    expect(
      computeTotalReqPerSec(m, new Set(['api-1', 'api-2']), tEnd),
    ).toBeCloseTo(300, 6);
  });

  it('drops hosts whose latest tick is older than the staleness window (Codex Finding 2)', () => {
    // api-1 ticked recently; api-2 went silent 5s ago. With the
    // default 3s staleness window, only api-1 contributes.
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd,
          requests_sum: 6_000,
          requests_n: 100,
          window_age_seconds: 60,
        }),
      ],
      [
        'api-2',
        mkTick({
          host: 'api-2',
          ts: tEnd - 5_000, // 5s old, beyond default 3s threshold
          requests_sum: 60_000,
          requests_n: 1000,
          window_age_seconds: 60,
        }),
      ],
    ]);
    // Only api-1 contributes: 6000/60 = 100. Pre-fix this would have
    // returned 100 + 1000 = 1100, overstating live traffic by 11×.
    expect(
      computeTotalReqPerSec(m, new Set(['api-1', 'api-2']), tEnd),
    ).toBeCloseTo(100, 6);
  });

  it('respects the stalenessMs override', () => {
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd - 500, // 500ms old
          requests_sum: 6_000,
          requests_n: 100,
          window_age_seconds: 60,
        }),
      ],
    ]);
    // 200ms staleness window — host is too old, contributes 0.
    expect(
      computeTotalReqPerSec(m, new Set(['api-1']), tEnd, 200),
    ).toBe(0);
    // 1s staleness window — host is fresh, contributes its rate.
    expect(
      computeTotalReqPerSec(m, new Set(['api-1']), tEnd, 1_000),
    ).toBeCloseTo(100, 6);
  });

  it('skips disabled hosts even if fresh', () => {
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd,
          requests_sum: 6_000,
          requests_n: 100,
        }),
      ],
      [
        'api-2',
        mkTick({
          host: 'api-2',
          ts: tEnd,
          requests_sum: 60_000,
          requests_n: 1000,
        }),
      ],
    ]);
    // Only api-1 enabled.
    expect(
      computeTotalReqPerSec(m, new Set(['api-1']), tEnd),
    ).toBeCloseTo(100, 6);
  });

  it('skips hosts with requests_n < 1 (rolling window has no requests events)', () => {
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd,
          requests_sum: 0,
          requests_n: 0, // empty bucket
          window_age_seconds: 60,
        }),
      ],
    ]);
    expect(
      computeTotalReqPerSec(m, new Set(['api-1']), tEnd),
    ).toBe(0);
  });

  it('uses window_age_seconds (not hardcoded 60) so a freshly-started aggregator does not show a warmup ramp', () => {
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd,
          requests_sum: 1_000,
          requests_n: 100,
          window_age_seconds: 10, // freshly-started aggregator, 10s of data
        }),
      ],
    ]);
    // 1000 / 10 = 100/s, not 1000 / 60 = 16.67/s
    expect(
      computeTotalReqPerSec(m, new Set(['api-1']), tEnd),
    ).toBeCloseTo(100, 6);
  });

  it('clamps the divisor at 0.001 when window_age_seconds is 0 (boot edge)', () => {
    const tEnd = 10_000;
    const m = new Map<string, HostTick>([
      [
        'api-1',
        mkTick({
          host: 'api-1',
          ts: tEnd,
          requests_sum: 1,
          requests_n: 1,
          window_age_seconds: 0,
        }),
      ],
    ]);
    // No NaN/Infinity; divisor clamped, gives a finite (huge) rate.
    const rate = computeTotalReqPerSec(m, new Set(['api-1']), tEnd);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeCloseTo(1_000, 0); // 1 / 0.001
  });
});
