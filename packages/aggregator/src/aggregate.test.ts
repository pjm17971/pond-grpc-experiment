import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import {
  schema,
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
 *
 * `startAggregate`'s broadcast callback now hands back structured
 * `AggregateAppendMsg` objects (was pre-encoded JSON `string`s) so
 * the broadcast layer can apply per-subscriber wire projections —
 * see the per-connection top-N work in `server.ts`. Tests collect
 * structured messages directly; no decode round-trip needed.
 */

function decodedFrames(
  frames: AggregateAppendMsg[],
): AggregateAppendMsg[] {
  return frames.filter((m) => m.type === 'aggregate-append');
}

describe('startAggregate', () => {
  it('emits one frame per sequence boundary with all hosts in it', async () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: AggregateAppendMsg[] = [];
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
    const frames: AggregateAppendMsg[] = [];
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
    const frames: AggregateAppendMsg[] = [];
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
    const frames: AggregateAppendMsg[] = [];
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
    const frames: AggregateAppendMsg[] = [];
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
    const frames: AggregateAppendMsg[] = [];
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

  it('retains snapshot history (rows + globals) within historyMaxAgeMs', async () => {
    // Step 8 — `getSnapshotHistory()` returns the recent tail of
    // emitted ticks for the WS-on-connect frame. Drive a few tick
    // boundaries with both hosts contributing, then assert the
    // history contains rows for every emitted (ts, host) pair plus
    // a globals tick per emit.
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: AggregateAppendMsg[] = [];
    const { stop, getSnapshotHistory } = startAggregate(
      live,
      (f) => frames.push(f),
      { tickMs: 50, historyMaxAgeMs: 5_000 },
    );
    try {
      const t0 = Date.now();
      for (let stage = 0; stage < 4; stage++) {
        for (let i = 0; i < 4; i++) {
          live.push([new Date(t0 + stage * 60 + i * 10), 0.5, 100, 'api-1']);
          live.push([new Date(t0 + stage * 60 + i * 10), 0.6, 100, 'api-2']);
        }
        await new Promise((res) => setTimeout(res, 60));
      }

      const appends = decodedFrames(frames);
      expect(appends.length).toBeGreaterThan(0);

      const history = getSnapshotHistory();
      // Globals: one per emitted append frame.
      expect(history.globals.length).toBe(appends.length);
      // Rows: sum of `rows.length` across every append. Both hosts
      // emit on every boundary once warm, so it's roughly
      // 2 × frames.length.
      const expectedRowsTotal = appends.reduce(
        (acc, f) => acc + f.rows.length,
        0,
      );
      expect(history.rows.length).toBe(expectedRowsTotal);
      // Both arrays sorted by ts (per-emit append preserves the
      // monotonic emit order; rows within a frame share a `ts`).
      for (let i = 1; i < history.rows.length; i++) {
        expect(history.rows[i].ts).toBeGreaterThanOrEqual(
          history.rows[i - 1].ts,
        );
      }
      for (let i = 1; i < history.globals.length; i++) {
        expect(history.globals[i].ts).toBeGreaterThan(
          history.globals[i - 1].ts,
        );
      }
    } finally {
      stop();
    }
  });

  it('evicts history older than historyMaxAgeMs (amortised eviction)', async () => {
    // 200ms tickMs + 300ms history window → at most ~2 frames'
    // worth retained. After 1 second of emits, history should hold
    // only the most recent 1–2 frames.
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const { stop, getSnapshotHistory } = startAggregate(live, () => {}, {
      tickMs: 100,
      historyMaxAgeMs: 250,
    });
    try {
      const t0 = Date.now();
      for (let i = 0; i < 20; i++) {
        live.push([new Date(t0 + i * 50), 0.5, 100, 'api-1']);
      }
      await new Promise((res) => setTimeout(res, 1_000));

      const history = getSnapshotHistory();
      // Only ticks within the last 250ms are retained.
      const newestTs = history.globals[history.globals.length - 1]?.ts;
      expect(newestTs).toBeDefined();
      for (const r of history.rows) {
        expect(r.ts).toBeGreaterThanOrEqual(newestTs! - 250);
      }
      for (const g of history.globals) {
        expect(g.ts).toBeGreaterThanOrEqual(newestTs! - 250);
      }
    } finally {
      stop();
    }
  });

  it('historyMaxAgeMs: 0 disables snapshot history (snapshot ships empty)', async () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const { stop, getSnapshotHistory } = startAggregate(live, () => {}, {
      tickMs: 50,
      historyMaxAgeMs: 0,
    });
    try {
      const t0 = Date.now();
      for (let i = 0; i < 6; i++) {
        live.push([new Date(t0 + i * 30), 0.5, 100, 'api-1']);
      }
      await new Promise((res) => setTimeout(res, 200));

      const history = getSnapshotHistory();
      expect(history.rows).toEqual([]);
      expect(history.globals).toEqual([]);
    } finally {
      stop();
    }
  });

  // ── sampleStride ────────────────────────────────────────────────
  // pond 0.17.0 added `live.partitionBy(...).sample({ stride })`;
  // `startAggregate` exposes it as `AggregateOptions.sampleStride`
  // and inserts the call between `partitionBy('host')` and the
  // fused rolling. The tests here pin the wire-visible behaviour
  // the friction-note RFC argued for: the rolling sees ~1/N
  // events, but `events_ingested_total` (and friends, sourced
  // upstream of the sample) still report the **true firehose**.
  // Closes the prototype's "counts post-sample" caveat.

  it('sampleStride: rolling sees ~1/N events; counters see full firehose', async () => {
    // One test, two pipelines side-by-side: same input, one with
    // `sampleStride: 1` (no-op) and one with `sampleStride: 4`.
    // Both consume the same `live` so timing edges + push order
    // are identical, and the comparison cancels any per-tick slop
    // a single-pipeline test would have to slop-tolerate.
    //
    // Asserts:
    //   - sampled `cpu_n` is materially smaller than unsampled
    //     (~1/4) — the per-host rolling really is thinning
    //   - globals counters (events_ingested_total,
    //     requests_ingested_total) match input on **both** pipelines
    //     — the sample is downstream of `live.on('batch')` so
    //     upstream counters see the true firehose. Resolves the
    //     pre-0.17 prototype's "counts post-sample" caveat.
    const N = 200;
    const liveUnsampled = new LiveSeries({
      name: 'metrics-u',
      schema,
      retention: { maxAge: '6m' },
    });
    const liveSampled = new LiveSeries({
      name: 'metrics-s',
      schema,
      retention: { maxAge: '6m' },
    });
    const framesU: AggregateAppendMsg[] = [];
    const framesS: AggregateAppendMsg[] = [];
    const { stop: stopU } = startAggregate(
      liveUnsampled,
      (f) => framesU.push(f),
      { tickMs: 50 },
    );
    const { stop: stopS } = startAggregate(
      liveSampled,
      (f) => framesS.push(f),
      { tickMs: 50, sampleStride: 4 },
    );
    try {
      // Push with synthetic timestamps in the past so every event is
      // already inside the 1m baseline window at the next tick
      // boundary — sidesteps the edge where events with ts after
      // the most-recently-fired boundary land in the next bucket
      // and aren't reflected in `last`. Spread tightly (200 events
      // × 1ms apart = 200ms span, well inside the trailing window).
      const tBase = Date.now() - 30_000;
      for (let i = 0; i < N; i++) {
        const ev: [Date, number, number, string] = [
          new Date(tBase + i),
          0.5,
          100,
          'api-1',
        ];
        liveUnsampled.push(ev);
        liveSampled.push(ev);
      }
      await new Promise((res) => setTimeout(res, 300));

      const lastU = decodedFrames(framesU)
        .flatMap((f) => f.rows)
        .filter((r) => r.host === 'api-1')
        .at(-1);
      const lastS = decodedFrames(framesS)
        .flatMap((f) => f.rows)
        .filter((r) => r.host === 'api-1')
        .at(-1);
      expect(lastU).toBeDefined();
      expect(lastS).toBeDefined();

      // Sanity: unsampled saw a substantial fraction of events.
      // Two side-by-side pipelines compete for event-loop time on
      // the test machine, and 200 events × 2 pipelines × 50ms
      // ticks is enough that ~20-30% of events can land past the
      // last frame's bucket boundary on a busy CI/dev machine. The
      // important property here is the **ratio** between sampled
      // and unsampled (asserted below); the absolute count is just
      // a smoke check that the unsampled path didn't degenerate.
      expect(lastU!.cpu_n).toBeGreaterThan(N * 0.6);
      expect(lastU!.cpu_n).toBeLessThanOrEqual(N);

      // The headline: sampled `cpu_n` is approximately 1/4 of
      // unsampled. The exact ratio drifts with timing edges; pin
      // a band that's tight enough to fail a regression where
      // sampling silently became a no-op (or doubled).
      const ratio = lastS!.cpu_n / lastU!.cpu_n;
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.4);

      // Counters upstream of the sample see the true firehose on
      // both pipelines. Pre-0.17 the prototype dropped events at
      // ingest, so `events_ingested_total` on the sampled
      // pipeline would have read ~50 (= 200/4); the post-0.17
      // contract is exactly N regardless of stride.
      const lastFrameU = decodedFrames(framesU).at(-1);
      const lastFrameS = decodedFrames(framesS).at(-1);
      expect(lastFrameU!.globals!.events_ingested_total).toBe(N);
      expect(lastFrameS!.globals!.events_ingested_total).toBe(N);
      expect(lastFrameU!.globals!.requests_ingested_total).toBe(N * 100);
      expect(lastFrameS!.globals!.requests_ingested_total).toBe(N * 100);

      // `events_per_sec` is a separate non-partitioned globals
      // rolling on `live`; it has its own pipeline path independent
      // of the per-host fused rolling that the sample op decorates.
      // Worth pinning explicitly because a future refactor that
      // accidentally moved the sample upstream would silently halve
      // this counter on the sampled pipeline. Both pipelines should
      // report the same true-firehose rate (within tick noise).
      expect(typeof lastFrameU!.globals!.events_per_sec).toBe('number');
      expect(typeof lastFrameS!.globals!.events_per_sec).toBe('number');
      // Same input, same rate — sample shouldn't affect this counter.
      const epsRatio =
        lastFrameS!.globals!.events_per_sec /
        Math.max(1, lastFrameU!.globals!.events_per_sec);
      expect(epsRatio).toBeGreaterThan(0.7);
      expect(epsRatio).toBeLessThan(1.4);
    } finally {
      stopU();
      stopS();
    }
  });

  it('sampleStride: per-partition independence — every host sees its own 1/N rate', async () => {
    // The friction-note RFC's headline correctness claim: when
    // `.sample({stride})` is chained AFTER `partitionBy('host')`,
    // each host's stream gets its own counter. A round-robin
    // producer that emits A, B, A, B, ... at stride=2 should drop
    // EVERY OTHER event for each host (not "all of one host's
    // events" — the bias trap a global counter would create).
    //
    // Pond-ts pins this library-side; this test pins it at the
    // experiment's seam so a future regression in our pipeline
    // composition (or a misconfiguration that hoists the sample
    // above partitionBy) fails loudly.
    const N_PER_HOST = 100;
    const live = new LiveSeries({
      name: 'metrics-2h',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: AggregateAppendMsg[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
      sampleStride: 2,
    });
    try {
      const tBase = Date.now() - 30_000;
      // Round-robin: A, B, A, B, ... — the worst case for a global
      // stride counter (would deterministically drop one entire
      // host). Per-host counters give each host an independent ½.
      for (let i = 0; i < N_PER_HOST * 2; i++) {
        const host = i % 2 === 0 ? 'api-A' : 'api-B';
        live.push([new Date(tBase + i), 0.5, 100, host]);
      }
      await new Promise((res) => setTimeout(res, 300));

      const lastA = decodedFrames(frames)
        .flatMap((f) => f.rows)
        .filter((r) => r.host === 'api-A')
        .at(-1);
      const lastB = decodedFrames(frames)
        .flatMap((f) => f.rows)
        .filter((r) => r.host === 'api-B')
        .at(-1);
      expect(lastA).toBeDefined();
      expect(lastB).toBeDefined();
      // Both hosts should see roughly half their events (~50 each).
      // Tight band: a global-counter bug would put one near 0 and
      // the other near 100; this catches that with margin.
      expect(lastA!.cpu_n).toBeGreaterThan(N_PER_HOST * 0.3);
      expect(lastA!.cpu_n).toBeLessThan(N_PER_HOST * 0.7);
      expect(lastB!.cpu_n).toBeGreaterThan(N_PER_HOST * 0.3);
      expect(lastB!.cpu_n).toBeLessThan(N_PER_HOST * 0.7);
      // And the two should be within 30% of each other (the bias
      // case would produce a >5× ratio).
      const ratio = lastA!.cpu_n / lastB!.cpu_n;
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.4);
    } finally {
      stop();
    }
  });

  it('partition-ordering inheritance: late events flow through partitions under reorder source (pond 0.17.1)', async () => {
    // Pre-0.17.1 the aggregator passed `partitionOrdering: 'reorder'`
    // + `partitionGraceWindowMs` explicitly into `startAggregate` to
    // work around pond's `partitionBy` defaulting per-partition sub-
    // series to `'strict'`. Pond 0.17.1 default-inherits ordering /
    // graceWindow / retention from the source `LiveSeries`, so this
    // test now pins what the LIBRARY guarantees — bare
    // `startAggregate(live)` with a `'reorder'` source means late
    // events flow through partitions without throwing.
    //
    // Scope of the assertion: push() must not throw, AND the late
    // event must land in the source's buffer. Whether the fused
    // rolling INCLUDES the late event in subsequent emits is the
    // milestone-B rolling-no-repair gap — out of scope here, and
    // observed during the harness run. Asserting cpu_n=4 would
    // conflate the propagation fix with the repair capability.
    const live = new LiveSeries({
      name: 'metrics-reorder',
      schema,
      retention: { maxAge: '60s' },
      ordering: 'reorder',
      graceWindow: '30s',
    });
    const frames: AggregateAppendMsg[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 50,
      // No partition-ordering / graceWindow args — relying on pond
      // 0.17.1's inheritance from the source.
    });
    try {
      const tBase = Date.now() - 30_000;
      live.push([new Date(tBase), 0.4, 100, 'api-1']);
      live.push([new Date(tBase + 5_000), 0.5, 100, 'api-1']);
      live.push([new Date(tBase + 10_000), 0.6, 100, 'api-1']);
      // Headline assertion: pond 0.17.1's inheritance kicks in and
      // this late push does NOT throw. Pre-0.17.1, bare
      // `partitionBy('host')` here would have crashed the partition
      // router.
      expect(() => {
        live.push([new Date(tBase + 7_000), 0.55, 100, 'api-1']);
      }).not.toThrow();

      expect(live.length).toBe(4);

      // Wait for tick + microtask drain so at least one fused frame
      // emits — pinned to confirm the pipeline survives after the
      // late event (no orphaned listeners, no stuck microtask).
      await new Promise((res) => setTimeout(res, 200));
      const apiRows = frames
        .flatMap((f) => f.rows)
        .filter((r) => r.host === 'api-1');
      expect(apiRows.length).toBeGreaterThan(0);
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
    current_avg: null,
    current_sd: null,
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
        current_avg: 0.5,
        current_sd: 0.06,
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
    expect(tickWithBaseline.current_avg).toBe(0.5);
    expect(tickWithBaseline.current_sd).toBe(0.06);

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
        current_avg: null,
        current_sd: null,
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
    expect(tickNullBaseline.current_avg).toBeNull();
    expect(tickNullBaseline.current_sd).toBeNull();
    expect(tickNullBaseline.window_age_seconds).toBe(25);
  });
});
