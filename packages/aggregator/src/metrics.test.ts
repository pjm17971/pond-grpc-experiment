import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import {
  configureLateness,
  recordLatenessOnIngest,
  recordPondInsertThrow,
  snapshot,
} from './metrics.js';

/**
 * Lateness detection tests. These pin the **classification** logic
 * — given a stream of (host, timeMs) pairs, the snapshot's `late.*`
 * counters reflect:
 *
 * - which events were strictly out-of-order at ingest
 * - which fell within the 1m rolling window vs past it
 * - which fell past the configured graceWindow
 *
 * The point of the milestone-B late-data driver is to characterise
 * pond's behavior when these counters are non-zero — the experiment
 * runs the producer's late-event injector against the aggregator
 * and reads `/metrics → late.*` to drive the friction note. Tests
 * here ensure the readout is correct so the friction note can trust
 * it.
 *
 * Module state is global; these tests rely on vitest's per-file
 * worker isolation. If multiple describes added in this file ever
 * need shared state reset, add a `beforeEach` that re-imports.
 * Today the state monotonically increases inside one test and the
 * next one reads cumulative values from the state the prior set up.
 */

const live = new LiveSeries({
  name: 'metrics-test',
  schema,
  retention: { maxAge: '6m' },
});
const stubLiveStats = () => live.stats();

describe('recordLatenessOnIngest classification', () => {
  it('classifies in-order events as not-late (no counters bumped)', () => {
    configureLateness({ rollingWindowMs: 60_000, graceWindowMs: 30_000 });
    const t = 1_700_000_000_000;
    recordLatenessOnIngest('api-1', t);
    recordLatenessOnIngest('api-1', t + 1);
    recordLatenessOnIngest('api-1', t + 2);
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.eventsLateAtIngestTotal).toBe(0);
    expect(m.late.eventsLateWithinRollingWindowTotal).toBe(0);
    expect(m.late.eventsLatePastRollingWindowTotal).toBe(0);
    expect(m.late.eventsLatePastGraceTotal).toBe(0);
    expect(m.late.highWaterTs).toBe(t + 2);
  });

  it('classifies a within-rolling-window late event correctly', () => {
    // High-water is t + 2 from the previous test. Push a late event
    // 5s behind: still inside the 60s rolling window + 30s grace.
    const t = 1_700_000_000_000;
    recordLatenessOnIngest('api-1', t + 2 - 5_000);
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.eventsLateAtIngestTotal).toBe(1);
    expect(m.late.eventsLateWithinRollingWindowTotal).toBe(1);
    expect(m.late.eventsLatePastRollingWindowTotal).toBe(0);
    expect(m.late.eventsLatePastGraceTotal).toBe(0);
    expect(m.late.lateWithinRollingWindowByHost).toEqual({ 'api-1': 1 });
    // Lateness reservoir picked up the lag.
    expect(m.late.latencyBehindHighWaterMs).not.toBeNull();
    expect(m.late.latencyBehindHighWaterMs!.count).toBe(1);
  });

  it('classifies a past-grace late event correctly (>30s behind)', () => {
    const t = 1_700_000_000_000;
    // 45s behind highWater — past 30s grace, but still inside the
    // 60s rolling window. Counter increments BOTH
    // `eventsLatePastGraceTotal` AND `eventsLateWithinRollingWindowTotal`
    // (the categories are independent: grace vs window).
    recordLatenessOnIngest('api-2', t + 2 - 45_000);
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.eventsLatePastGraceTotal).toBe(1);
    expect(m.late.eventsLateWithinRollingWindowTotal).toBe(2); // +1 from this test
  });

  it('classifies a past-rolling-window late event correctly (>60s behind)', () => {
    const t = 1_700_000_000_000;
    // 90s behind highWater — past both grace and rolling window.
    recordLatenessOnIngest('api-3', t + 2 - 90_000);
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.eventsLatePastRollingWindowTotal).toBe(1);
    expect(m.late.eventsLatePastGraceTotal).toBe(2); // +1 from this test
    // `eventsLateWithinRollingWindowTotal` did NOT increment — past-
    // baseline events are exclusive of the within-rolling-window class.
    expect(m.late.eventsLateWithinRollingWindowTotal).toBe(2);
  });

  it('per-host counter accumulates for the within-rolling-window class only', () => {
    const t = 1_700_000_000_000;
    // Three more api-3 events, all within rolling window.
    for (let i = 0; i < 3; i++) {
      recordLatenessOnIngest('api-3', t + 2 - 1_000);
    }
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.lateWithinRollingWindowByHost['api-3']).toBe(3);
    // The earlier past-rolling-window api-3 push didn't increment per-host
    // (host-bias drift is a within-rolling-window phenomenon).
    expect(m.late.lateWithinRollingWindowByHost['api-2']).toBe(1);
  });

  it('high-water never decreases', () => {
    const t = 1_700_000_000_000;
    // After all the late events above, highWater should still be
    // t + 2 (set by the in-order push at the very start).
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.highWaterTs).toBe(t + 2);
  });

  it('a NEW high-water in the same stream advances the mark', () => {
    const t = 1_700_000_000_000;
    recordLatenessOnIngest('api-1', t + 1_000_000); // way ahead
    const m = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    });
    expect(m.late.highWaterTs).toBe(t + 1_000_000);
    // No counter ticked — this event was MORE recent than highWater.
    // Total: 1 within-rolling-window (+5s) + 1 past-grace (+45s) + 1
    // past-rolling-window (+90s) + 3 within-rolling-window api-3 (+1s) = 6.
    expect(m.late.eventsLateAtIngestTotal).toBe(6);
  });
});

describe('recordPondInsertThrow', () => {
  it('exposes the rejection counter in the snapshot', () => {
    const before = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    }).late.pondInsertThrowsTotal;
    recordPondInsertThrow();
    recordPondInsertThrow();
    const after = snapshot({
      liveSeriesLength: 0,
      wsClientBufferedAmounts: [],
      liveStats: stubLiveStats(),
    }).late.pondInsertThrowsTotal;
    expect(after - before).toBe(2);
  });
});

describe('snapshot.late.liveStats', () => {
  it('passes pond stats through verbatim', () => {
    const liveStats = {
      ingested: 42,
      evicted: 7,
      rejected: 3,
      length: 35,
      earliestTs: 1_000,
      latestTs: 2_000,
    };
    const m = snapshot({
      liveSeriesLength: 35,
      wsClientBufferedAmounts: [],
      liveStats,
    });
    expect(m.late.liveStats).toEqual(liveStats);
  });
});
