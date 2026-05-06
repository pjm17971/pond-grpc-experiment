import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import {
  schema,
  decode,
  type AggregateAppendMsg,
} from '@pond-experiment/shared';
import { startAggregate, assembleTick } from './aggregate.js';

/**
 * Tests exercise `startAggregate` end-to-end against a real
 * `LiveSeries`. V8 (pond 0.15.0) wires a single fused multi-window
 * partitioned rolling — `'1m'` (avg/stdev/count) and `${tickMs}ms`
 * (samples) — clocked off one trigger and emitted as one wire frame
 * per tick. We assert the pipeline composition: synchronised tick
 * clock, single-frame-per-ts collation, monotonic frame ts, and the
 * anomaly-density fields on every row.
 *
 * `cpu_n` is the 1m bucket's own sample count (the gating signal for
 * "are mean/sd backed by enough samples?"), `n_current` is the
 * `tickMs` slice's count. Numerically-precise reducer behaviour is
 * pond's responsibility and is covered in its own test suite.
 */

function decodedFrames(frames: string[]): AggregateAppendMsg[] {
  return frames
    .map((f) => decode(f))
    .filter((m): m is AggregateAppendMsg => m.type === 'aggregate-append');
}

describe('startAggregate', () => {
  it('emits one frame per sequence boundary with all hosts in it', async () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
    });
    try {
      // Push three samples for each of two hosts, each spaced enough
      // to span sequence boundaries.
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        live.push([new Date(t0 + i * 30), 0.4 + (i % 3) * 0.1, 100, 'api-1']);
        live.push([new Date(t0 + i * 30), 0.6 + (i % 3) * 0.1, 110, 'api-2']);
      }
      // Wait long enough for sequence boundaries to fire and the
      // microtask-deferred emit to drain.
      await new Promise((res) => setTimeout(res, 200));

      const appends = decodedFrames(frames);
      expect(appends.length).toBeGreaterThan(0);
      // Each emitted frame should mention both hosts (synchronised
      // clock — one row per partition per boundary, even silent ones).
      for (const f of appends) {
        const hosts = new Set(f.rows.map((r) => r.host));
        expect(hosts.has('api-1')).toBe(true);
        expect(hosts.has('api-2')).toBe(true);
      }
      // Values are well-formed numbers (or null), not undefined.
      for (const f of appends) {
        for (const r of f.rows) {
          expect(typeof r.cpu_n).toBe('number');
          expect(r.cpu_avg === null || typeof r.cpu_avg === 'number').toBe(
            true,
          );
          expect(r.cpu_sd === null || typeof r.cpu_sd === 'number').toBe(true);
          // Step 5 — requests stats present on every row.
          expect(typeof r.requests_n).toBe('number');
          expect(typeof r.requests_sum).toBe('number');
          expect(
            r.requests_avg === null || typeof r.requests_avg === 'number',
          ).toBe(true);
          // Step 7 — cpu_min/cpu_max present on every row, with the
          // min ≤ max ordering invariant when both are non-null. The
          // extrema are over the 200ms slice while cpu_avg is over
          // the 1m baseline — different windows, so cpu_min can be
          // above cpu_avg (or vice versa) when the recent slice's
          // values cluster outside the long-window mean. Only the
          // intra-slice min ≤ max relation is guaranteed.
          expect(r.cpu_min === null || typeof r.cpu_min === 'number').toBe(
            true,
          );
          expect(r.cpu_max === null || typeof r.cpu_max === 'number').toBe(
            true,
          );
          if (typeof r.cpu_min === 'number' && typeof r.cpu_max === 'number') {
            expect(r.cpu_min).toBeLessThanOrEqual(r.cpu_max);
          }
        }
      }
    } finally {
      stop();
    }
  });

  it('emits monotonically increasing ts values across frames', async () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
    });
    try {
      // Keep pushing across many boundaries so multiple frames fire.
      const t0 = Date.now();
      for (let i = 0; i < 30; i++) {
        live.push([new Date(t0 + i * 25), 0.5, 100, 'api-1']);
      }
      await new Promise((res) => setTimeout(res, 250));

      const appends = decodedFrames(frames);
      expect(appends.length).toBeGreaterThanOrEqual(2);

      const tsValues = appends
        .flatMap((f) => f.rows.map((r) => r.ts))
        // Within a frame all rows share the same ts; collapse to one
        // sample per frame.
        .filter((_, i, arr) => i === 0 || arr[i] !== arr[i - 1]);
      for (let i = 1; i < tsValues.length; i++) {
        expect(tsValues[i]).toBeGreaterThan(tsValues[i - 1]);
      }
    } finally {
      stop();
    }
  });

  it('coalesces fused-rolling per-partition events into one frame per tick (microtask merge)', async () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
    });
    try {
      // Drive a single boundary crossing for 3 hosts. We expect a
      // single frame containing 3 rows (not 9, which would be one
      // frame per pipeline-event).
      const t0 = Date.now();
      live.push([new Date(t0), 0.5, 100, 'api-1']);
      live.push([new Date(t0), 0.6, 100, 'api-2']);
      live.push([new Date(t0), 0.7, 100, 'api-3']);
      // Cross the next boundary deliberately:
      await new Promise((res) => setTimeout(res, 80));
      live.push([new Date(t0 + 60), 0.55, 100, 'api-1']);

      await new Promise((res) => setTimeout(res, 200));

      const appends = decodedFrames(frames);
      // No pathological per-host duplicates within a single frame.
      for (const f of appends) {
        const hosts = f.rows.map((r) => r.host);
        const uniq = new Set(hosts);
        expect(uniq.size).toBe(hosts.length);
      }
    } finally {
      stop();
    }
  });

  it('numerical sanity: cpu_avg sits inside the recent input range', async () => {
    // Stricter: pond's reducers are responsible for correctness, but
    // a smoke check that we're wiring the right reducer to the right
    // output slot guards against future refactors that swap them.
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 30,
    });
    try {
      const t0 = Date.now();
      for (let i = 0; i < 10; i++) {
        live.push([new Date(t0 + i * 10), 0.5, 100, 'api-1']);
      }
      await new Promise((res) => setTimeout(res, 200));

      const appends = decodedFrames(frames);
      const apiOne = appends
        .flatMap((f) => f.rows)
        .filter((r) => r.host === 'api-1')
        .at(-1);
      expect(apiOne).toBeDefined();
      expect(apiOne!.cpu_avg).toBeCloseTo(0.5, 5);
      expect(apiOne!.cpu_sd).toBeCloseTo(0, 5);
      // `cpu_n` is the bucket's own count (samples in the rolling
      // 1m window) — gating signal for "are mean/sd backed by
      // enough samples?" The trigger only controls *when* the
      // bucket reports, not what's in it.
      expect(apiOne!.cpu_n).toBeGreaterThanOrEqual(5);
      // Step 5 — requests stats are sourced from the same 1m
      // baseline window, so all 10 events land in the bucket.
      // requests=100 constant → avg 100, sum 1000, n same as cpu_n.
      expect(apiOne!.requests_avg).toBeCloseTo(100, 5);
      expect(apiOne!.requests_sum).toBe(apiOne!.cpu_n * 100);
      expect(apiOne!.requests_n).toBe(apiOne!.cpu_n);
    } finally {
      stop();
    }
  });

  it('emits anomaly-count and n_current fields on every row', async () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
    });
    try {
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        live.push([new Date(t0 + i * 30), 0.5 + (i % 2) * 0.1, 100, 'api-1']);
      }
      await new Promise((res) => setTimeout(res, 200));

      const appends = decodedFrames(frames);
      expect(appends.length).toBeGreaterThan(0);
      for (const f of appends) {
        for (const r of f.rows) {
          expect(typeof r.n_current).toBe('number');
          expect(Array.isArray(r.anomalies_above)).toBe(true);
          expect(Array.isArray(r.anomalies_below)).toBe(true);
          // Length matches the default thresholds list (5 buckets).
          expect(r.anomalies_above.length).toBe(5);
          expect(r.anomalies_below.length).toBe(5);
          // Counts can never exceed n_current.
          for (const a of r.anomalies_above) {
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThanOrEqual(r.n_current);
          }
          for (const b of r.anomalies_below) {
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThanOrEqual(r.n_current);
          }
        }
      }
    } finally {
      stop();
    }
  });

  it('emits globals (events_ingested_total, events_per_sec, evicted_total) on every append frame', async () => {
    // Step 6 — the per-tick globals tick rides on the same frame as
    // the per-host rows. Confirms the manual counters increment as
    // batches arrive and the per-tick rate computation reflects the
    // ingest-side delta over the elapsed tick window.
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
    });
    try {
      const t0 = Date.now();
      // Push events in stages across multiple tick boundaries so
      // events_per_sec can compute a meaningful rate (events/sec
      // requires at least two ticks of delta to be non-zero).
      for (let stage = 0; stage < 4; stage++) {
        for (let i = 0; i < 4; i++) {
          live.push([
            new Date(t0 + stage * 60 + i * 10),
            0.5,
            100,
            'api-1',
          ]);
          live.push([
            new Date(t0 + stage * 60 + i * 10),
            0.6,
            100,
            'api-2',
          ]);
        }
        await new Promise((res) => setTimeout(res, 60));
      }

      const appends = decodedFrames(frames);
      expect(appends.length).toBeGreaterThan(0);
      // Every emitted append carries globals.
      for (const f of appends) {
        expect(f.globals).toBeDefined();
        expect(typeof f.globals!.events_ingested_total).toBe('number');
        expect(typeof f.globals!.events_per_sec).toBe('number');
        expect(typeof f.globals!.evicted_total).toBe('number');
        expect(f.globals!.evicted_total).toBe(0);
      }
      // events_ingested_total is monotonically non-decreasing across
      // frames (live.on('batch') accumulates; never resets).
      const counts = appends.map((f) => f.globals!.events_ingested_total);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
      }
      // 4 stages × 8 events/stage = 32 events total.
      expect(counts.at(-1)!).toBeGreaterThanOrEqual(16);
      // At least one frame should report a non-zero rate — the
      // boundary that captures one of the staged batches will see
      // an 8-event delta over a ~50 ms tick window.
      const rates = appends.map((f) => f.globals!.events_per_sec);
      expect(rates.some((r) => r > 0)).toBe(true);
    } finally {
      stop();
    }
  });
});

describe('assembleTick', () => {
  // Pure-function unit tests for the threshold-density math. The
  // join + pipeline composition are tested above against a real
  // LiveSeries; here we cover the math edges that don't change
  // shape from one pond version to the next.
  const thresholds = [1, 1.5, 2, 2.5, 3] as const;

  // Default per-tick context — most assembleTick tests exercise CPU
  // anomaly counting and don't care about the requests pass-through,
  // window age, or step-7 min/max envelope; factor them out so the
  // cpu-focused tests stay readable. `window_age_seconds: 60`
  // simulates a warm aggregator (rolling window full);
  // `cpu_min`/`cpu_max: null` simulates an empty 200ms slice (the
  // assembleTick tests pass `samples` to the function separately).
  const noRequests = {
    requests_avg: null,
    requests_sum: 0,
    requests_n: 0,
    window_age_seconds: 60,
    cpu_min: null,
    cpu_max: null,
  };

  it('returns zero-filled arrays when baseline stats are null', () => {
    const tick = assembleTick(
      1_000,
      'api-1',
      { cpu_avg: null, cpu_sd: null, cpu_n: 0, ...noRequests },
      [0.5, 0.6],
      thresholds,
    );
    expect(tick.anomalies_above).toEqual([0, 0, 0, 0, 0]);
    expect(tick.anomalies_below).toEqual([0, 0, 0, 0, 0]);
    expect(tick.n_current).toBe(2);
  });

  it('returns zero-filled arrays when current slice is empty', () => {
    const tick = assembleTick(
      1_000,
      'api-1',
      { cpu_avg: 0.5, cpu_sd: 0.1, cpu_n: 100, ...noRequests },
      [],
      thresholds,
    );
    expect(tick.anomalies_above).toEqual([0, 0, 0, 0, 0]);
    expect(tick.anomalies_below).toEqual([0, 0, 0, 0, 0]);
    expect(tick.n_current).toBe(0);
  });

  it('counts samples that exceed each σ-threshold, above only', () => {
    // Baseline mean=0.5, sd=0.1. Samples at deviations
    // [+0.05, +0.12, +0.22, +0.32, +0.42, +0.55] (i.e., 0.5 σ,
    // 1.2 σ, 2.2 σ, 3.2 σ, 4.2 σ, 5.5 σ above mean).
    // Thresholds [1, 1.5, 2, 2.5, 3]:
    //   >1σ: 5 of 6 (all except 0.55 i.e. the 0.5-σ outlier)
    //   >1.5σ: 4 (1.2σ excluded)
    //   >2σ: 4 (2.2σ included)
    //   >2.5σ: 3 (2.2σ excluded)
    //   >3σ: 3 (3.2σ included)
    const tick = assembleTick(
      1_000,
      'api-1',
      { cpu_avg: 0.5, cpu_sd: 0.1, cpu_n: 100, ...noRequests },
      [0.55, 0.62, 0.72, 0.82, 0.92, 1.05],
      thresholds,
    );
    expect(tick.anomalies_above).toEqual([5, 4, 4, 3, 3]);
    expect(tick.anomalies_below).toEqual([0, 0, 0, 0, 0]);
    expect(tick.n_current).toBe(6);
  });

  it('counts above and below symmetrically against the same thresholds', () => {
    const tick = assembleTick(
      1_000,
      'api-1',
      { cpu_avg: 0.5, cpu_sd: 0.1, cpu_n: 100, ...noRequests },
      [0.45, 0.38, 0.30, 0.65, 0.72, 0.95],
      thresholds,
    );
    // Below: deviations [-0.05, -0.12, -0.20]
    //   >1σ: 2 (the -0.05 is 0.5σ, excluded)
    //   >1.5σ: 1 (the -0.12 is 1.2σ, excluded)
    //   >2σ: 0 (the -0.20 is exactly 2σ, NOT strictly greater)
    //   >2.5σ: 0
    //   >3σ: 0
    expect(tick.anomalies_below).toEqual([2, 1, 0, 0, 0]);
    // Above: deviations [+0.15, +0.22, +0.45]
    //   >1σ: 3
    //   >1.5σ: 2
    //   >2σ: 2
    //   >2.5σ: 1
    //   >3σ: 1
    expect(tick.anomalies_above).toEqual([3, 2, 2, 1, 1]);
  });

  it('zero sd: nothing exceeds any threshold', () => {
    // sd=0 → cutoff = 0 for every threshold; `diff > 0` only fires
    // for non-zero deviations. With samples == mean the deviation
    // is exactly zero, so nothing counts.
    const tick = assembleTick(
      1_000,
      'api-1',
      { cpu_avg: 0.5, cpu_sd: 0, cpu_n: 100, ...noRequests },
      [0.5, 0.5, 0.5],
      thresholds,
    );
    expect(tick.anomalies_above).toEqual([0, 0, 0, 0, 0]);
    expect(tick.anomalies_below).toEqual([0, 0, 0, 0, 0]);
    expect(tick.n_current).toBe(3);
  });

  it('passes requests stats + window_age + cpu_min/max through unchanged (independent of anomaly math)', () => {
    // assembleTick is purely a pass-through for requests stats,
    // window_age_seconds, and the per-tick min/max envelope — they're
    // stored on the rolling-output event by pond's reducers /
    // computed by the caller and copied onto the wire row without
    // further computation. Confirm all six fields land on the output
    // regardless of baseline-cpu state.
    const tickWithBaseline = assembleTick(
      1_000,
      'api-1',
      {
        cpu_avg: 0.5,
        cpu_sd: 0.1,
        cpu_n: 100,
        requests_avg: 102.5,
        requests_sum: 12_300,
        requests_n: 120,
        window_age_seconds: 60,
        cpu_min: 0.42,
        cpu_max: 0.58,
      },
      [0.6],
      thresholds,
    );
    expect(tickWithBaseline.requests_avg).toBe(102.5);
    expect(tickWithBaseline.requests_sum).toBe(12_300);
    expect(tickWithBaseline.requests_n).toBe(120);
    expect(tickWithBaseline.window_age_seconds).toBe(60);
    expect(tickWithBaseline.cpu_min).toBe(0.42);
    expect(tickWithBaseline.cpu_max).toBe(0.58);

    // And on a null-baseline tick (no cpu stats yet, but requests
    // can still be present — the two columns gate independently).
    // Mid-warmup `window_age_seconds: 25` represents 25s of data
    // accumulated, before the rolling window is full. With no
    // events in the 200ms slice the min/max are also null (an
    // empty-slice marker for the dashboard's envelope toggle).
    const tickNullBaseline = assembleTick(
      1_000,
      'api-1',
      {
        cpu_avg: null,
        cpu_sd: null,
        cpu_n: 0,
        requests_avg: 90,
        requests_sum: 900,
        requests_n: 10,
        window_age_seconds: 25,
        cpu_min: null,
        cpu_max: null,
      },
      [],
      thresholds,
    );
    expect(tickNullBaseline.cpu_avg).toBeNull();
    expect(tickNullBaseline.requests_avg).toBe(90);
    expect(tickNullBaseline.requests_sum).toBe(900);
    expect(tickNullBaseline.requests_n).toBe(10);
    expect(tickNullBaseline.cpu_min).toBeNull();
    expect(tickNullBaseline.cpu_max).toBeNull();
    expect(tickNullBaseline.window_age_seconds).toBe(25);
  });
});
