import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Event, EventBatch } from '@pond-experiment/shared/grpc';
import { startLateInjector, parseHostBias } from './lateInjector.js';

/**
 * Tests for the late-event injector. The whole point of the
 * injector is reproducibility (seeded RNG) — the milestone-B
 * brief explicitly requires that two runs of the same workload
 * produce identical results. So most assertions here pin exact
 * counts/identities under a known seed; if the RNG drifts (e.g.
 * mulberry32 implementation tweak), these tests will fail and
 * that's the right signal.
 */

const mkEvent = (host: string, t = 1_000): Event => ({
  timeMs: t,
  cpu: 0.5,
  requests: 100,
  host,
});

const mkBatch = (...hosts: string[]): EventBatch => ({
  events: hosts.map((h) => mkEvent(h)),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startLateInjector', () => {
  it('passes events through unchanged when fraction is 0', () => {
    const downstream = vi.fn();
    const injector = startLateInjector(downstream, {
      fraction: 0,
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 1,
    });
    injector.wrappedOnBatch(mkBatch('a', 'b', 'c'));
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream.mock.calls[0][0].events.length).toBe(3);
    const m = injector.metrics();
    expect(m.events_emitted_total).toBe(3);
    expect(m.events_emitted_late_total).toBe(0);
    injector.stop();
  });

  it('holds late events with timers (verified via fake timers)', () => {
    vi.useFakeTimers();
    const downstream = vi.fn();
    const injector = startLateInjector(downstream, {
      fraction: 1, // every event late
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 1,
    });
    injector.wrappedOnBatch(mkBatch('a', 'b', 'c'));
    // Nothing emitted yet — all events held by setTimeout.
    expect(downstream).not.toHaveBeenCalled();
    expect(injector.metrics().events_emitted_total).toBe(0);
    expect(injector.metrics().events_emitted_late_total).toBe(0);

    // Advance 30s (well past the tail) — every timer should fire.
    vi.advanceTimersByTime(30_000);
    expect(downstream).toHaveBeenCalledTimes(3);
    const m = injector.metrics();
    expect(m.events_emitted_total).toBe(3);
    expect(m.events_emitted_late_total).toBe(3);
    injector.stop();
  });

  it('preserves the original timeMs on held events (the whole point of "late")', () => {
    vi.useFakeTimers();
    const downstream = vi.fn();
    const injector = startLateInjector(downstream, {
      fraction: 1,
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 1,
    });
    const original = mkEvent('api-1', 100_000); // ts well in the past
    injector.wrappedOnBatch({ events: [original] });
    vi.advanceTimersByTime(30_000);

    expect(downstream).toHaveBeenCalledTimes(1);
    const released = downstream.mock.calls[0][0].events[0];
    // The released event's `timeMs` is the ORIGINAL, not the
    // wall-clock time of the release. That's what makes it
    // "late" at the aggregator's `LiveSeries` push.
    expect(released.timeMs).toBe(100_000);
    injector.stop();
  });

  it('is deterministic under a fixed seed (seed-1 vs seed-1 are identical)', () => {
    // Two injectors with the same seed should make the same
    // late/on-time decisions for the same input batch.
    const dsA = vi.fn();
    const dsB = vi.fn();
    const optsBase = {
      fraction: 0.3, // partial — actually exercises the rng
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 42,
    };
    const a = startLateInjector(dsA, optsBase);
    const b = startLateInjector(dsB, optsBase);
    const batch = mkBatch('h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7');
    a.wrappedOnBatch(batch);
    b.wrappedOnBatch(batch);
    // On-time emissions are immediate; the dispatched on-time
    // batches should be identical between the two injectors.
    const aBatches = dsA.mock.calls.map((c) => c[0]);
    const bBatches = dsB.mock.calls.map((c) => c[0]);
    expect(aBatches.length).toBe(bBatches.length);
    for (let i = 0; i < aBatches.length; i++) {
      expect(aBatches[i].events.map((e: Event) => e.host)).toEqual(
        bBatches[i].events.map((e: Event) => e.host),
      );
    }
    a.stop();
    b.stop();
  });

  it('different seeds produce different late/on-time partitions', () => {
    const dsA = vi.fn();
    const dsB = vi.fn();
    const a = startLateInjector(dsA, {
      fraction: 0.3,
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 1,
    });
    const b = startLateInjector(dsB, {
      fraction: 0.3,
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 2,
    });
    const hosts = Array.from({ length: 30 }, (_, i) => `h${i}`);
    a.wrappedOnBatch({ events: hosts.map((h) => mkEvent(h)) });
    b.wrappedOnBatch({ events: hosts.map((h) => mkEvent(h)) });
    const aOnTime: string[] = [];
    for (const c of dsA.mock.calls) for (const e of c[0].events) aOnTime.push(e.host);
    const bOnTime: string[] = [];
    for (const c of dsB.mock.calls) for (const e of c[0].events) bOnTime.push(e.host);
    // Same length only if both seeds happen to make exactly the
    // same fraction late, which is astronomically unlikely. If
    // they ARE identical, the seeds aren't actually changing
    // behaviour and the test is a bug.
    expect(aOnTime).not.toEqual(bOnTime);
    a.stop();
    b.stop();
  });

  it('hostBias raises the per-host late probability for named hosts', () => {
    // 100% of api-3 events should be late (base 0 + bias 1 = 1);
    // 0% of api-1 should be late (base 0 + bias 0 = 0).
    const downstream = vi.fn();
    const injector = startLateInjector(downstream, {
      fraction: 0,
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      hostBias: { 'api-3': 1 },
      seed: 1,
    });
    const batch = mkBatch('api-1', 'api-3', 'api-1', 'api-3', 'api-1', 'api-3');
    injector.wrappedOnBatch(batch);
    // Only the api-1 events made it on-time; the api-3 events are
    // held in setTimeout. So the immediate downstream call has 3
    // events, all api-1.
    expect(downstream).toHaveBeenCalledTimes(1);
    const onTime = downstream.mock.calls[0][0].events;
    expect(onTime.length).toBe(3);
    expect(onTime.every((e: Event) => e.host === 'api-1')).toBe(true);
    injector.stop();
  });

  it('lateness reservoir tracks p50/p99 sensibly', () => {
    vi.useFakeTimers();
    const downstream = vi.fn();
    const injector = startLateInjector(downstream, {
      fraction: 1,
      delayMeanMs: 1_000,
      delayTailMs: 10_000,
      seed: 1,
    });
    // Push enough events that the reservoir has > 100 samples.
    const batch = { events: Array.from({ length: 200 }, (_, i) => mkEvent(`h${i}`)) };
    injector.wrappedOnBatch(batch);
    // Don't even need to advance timers — `lateness_p50_ms` is
    // recorded at decision time, not release time.
    const m = injector.metrics();
    expect(m.lateness_samples_count).toBe(200);
    // Median should be in the ballpark of the configured median
    // (1s). Allow generous tolerance — log-normal sampling has
    // real variance.
    expect(m.lateness_p50_ms).toBeGreaterThan(300);
    expect(m.lateness_p50_ms).toBeLessThan(3000);
    // p99 should be in the ballpark of the configured tail (10s).
    expect(m.lateness_p99_ms).toBeGreaterThan(3_000);
    expect(m.lateness_p99_ms).toBeLessThan(30_000);
    expect(m.lateness_p99_ms).toBeGreaterThan(m.lateness_p50_ms);
    injector.stop();
  });

  it('stop() cancels pending timers (no late events emitted post-stop)', () => {
    vi.useFakeTimers();
    const downstream = vi.fn();
    const injector = startLateInjector(downstream, {
      fraction: 1,
      delayMeanMs: 1_000,
      delayTailMs: 5_000,
      seed: 1,
    });
    injector.wrappedOnBatch(mkBatch('a', 'b', 'c'));
    injector.stop();
    vi.advanceTimersByTime(30_000);
    // No emissions — all timers cleared.
    expect(downstream).not.toHaveBeenCalled();
  });
});

describe('parseHostBias', () => {
  it('returns undefined for empty / unset / whitespace', () => {
    expect(parseHostBias(undefined)).toBeUndefined();
    expect(parseHostBias('')).toBeUndefined();
    expect(parseHostBias('   ')).toBeUndefined();
  });

  it('parses a single host:fraction pair', () => {
    expect(parseHostBias('api-3:0.05')).toEqual({ 'api-3': 0.05 });
  });

  it('parses multiple comma-separated pairs', () => {
    expect(parseHostBias('api-3:0.05,api-7:0.1')).toEqual({
      'api-3': 0.05,
      'api-7': 0.1,
    });
  });

  it('tolerates whitespace around tokens', () => {
    expect(parseHostBias('  api-3 : 0.05 , api-7:0.1 ')).toEqual({
      'api-3': 0.05,
      'api-7': 0.1,
    });
  });

  it('skips malformed entries silently (defensive)', () => {
    // Malformed `api-3` (no colon) skipped; `api-7:abc` (NaN frac)
    // skipped; `api-9:0.2` valid.
    expect(parseHostBias('api-3,api-7:abc,api-9:0.2')).toEqual({
      'api-9': 0.2,
    });
  });

  it('rejects out-of-range fractions', () => {
    expect(parseHostBias('api-3:5,api-7:0.1')).toEqual({ 'api-7': 0.1 });
    expect(parseHostBias('api-3:-2,api-7:0.1')).toEqual({ 'api-7': 0.1 });
  });

  it('returns undefined when every entry is malformed', () => {
    expect(parseHostBias('garbage,more-garbage')).toBeUndefined();
  });
});
