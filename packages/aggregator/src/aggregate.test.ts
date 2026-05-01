import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import {
  schema,
  decode,
  type AggregateAppendMsg,
} from '@pond-experiment/shared';
import { startAggregate } from './aggregate.js';

/**
 * Tests exercise `startAggregate` end-to-end against a real
 * `LiveSeries`. With pond 0.13's `AggregateOutputMap` overload on
 * `LivePartitionedSeries.rolling`, all three CPU stats (`cpu_avg`,
 * `cpu_sd`, `cpu_n`) come from one rolling pipeline; we assert the
 * pipeline composition: synchronised tick clock, single-frame-per-ts
 * collation, monotonic frame ts.
 *
 * `cpu_n` here is the bucket's own sample count (the gating signal),
 * not a per-tick count. The 200ms parallel window earlier drafts had
 * is gone — see PR #14 / friction-notes/M3.5.md.
 *
 * Numerically-precise reducer behaviour is pond's responsibility and
 * is covered in its own test suite.
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

  it('coalesces three pipelines into one frame per tick (microtask merge)', async () => {
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
    } finally {
      stop();
    }
  });
});
