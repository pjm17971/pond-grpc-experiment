import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import { HostAggregator, startAggregate } from './aggregate.js';

describe('HostAggregator', () => {
  it('returns no rows before any sample arrives', () => {
    const agg = new HostAggregator();
    expect(agg.tick(1_000_000)).toEqual([]);
  });

  it('emits cpu_avg and cpu_sd over the rolling 1m window', () => {
    const agg = new HostAggregator();
    const tick = 1_000_000;
    // Six samples over the 1m window. Mean = 0.55, population SD over
    // [0.4, 0.5, 0.6, 0.5, 0.7, 0.6] = sqrt(0.0091...) ≈ 0.0957.
    agg.record('api-1', tick - 50_000, 0.4);
    agg.record('api-1', tick - 40_000, 0.5);
    agg.record('api-1', tick - 30_000, 0.6);
    agg.record('api-1', tick - 20_000, 0.5);
    agg.record('api-1', tick - 10_000, 0.7);
    agg.record('api-1', tick - 1_000, 0.6);

    const rows = agg.tick(tick);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ts: tick, host: 'api-1', cpu_n: 6 });
    expect(rows[0].cpu_avg!).toBeCloseTo(0.55, 6);
    expect(rows[0].cpu_sd!).toBeCloseTo(0.0957, 3);
  });

  it('cpu_n counts only samples that arrived since the previous tick', () => {
    const agg = new HostAggregator();
    agg.record('api-1', 1_000_000, 0.5);
    agg.record('api-1', 1_000_001, 0.6);
    const t1 = agg.tick(1_000_010);
    expect(t1[0].cpu_n).toBe(2);
    // No new samples between t1 and t2.
    const t2 = agg.tick(1_000_020);
    expect(t2[0].cpu_n).toBe(0);
    // The rolling avg is unchanged — the samples are still in the window.
    expect(t2[0].cpu_avg).toBe(t1[0].cpu_avg);
    // One new sample, then tick again.
    agg.record('api-1', 1_000_025, 0.9);
    const t3 = agg.tick(1_000_030);
    expect(t3[0].cpu_n).toBe(1);
    expect(t3[0].cpu_avg!).toBeCloseTo((0.5 + 0.6 + 0.9) / 3, 6);
  });

  it('drops samples older than the 1m window from the rolling stats', () => {
    const agg = new HostAggregator();
    // Put one stale sample at t=0, one fresh sample at t=70s.
    agg.record('api-1', 0, 999); // way out of window — should not contribute
    agg.record('api-1', 70_000, 0.5);
    const rows = agg.tick(70_000);
    // Only the fresh sample contributes — mean is its value, sd is 0.
    expect(rows[0].cpu_avg).toBeCloseTo(0.5, 6);
    expect(rows[0].cpu_sd).toBeCloseTo(0, 6);
  });

  it('partitions per-host stats correctly', () => {
    const agg = new HostAggregator();
    agg.record('api-1', 1_000_000, 0.4);
    agg.record('api-1', 1_000_001, 0.6);
    agg.record('api-2', 1_000_002, 0.9);
    agg.record('api-2', 1_000_003, 0.9);
    const rows = agg.tick(1_000_010);
    const byHost = new Map(rows.map((r) => [r.host, r]));
    expect(byHost.get('api-1')!.cpu_avg).toBeCloseTo(0.5, 6);
    expect(byHost.get('api-1')!.cpu_n).toBe(2);
    expect(byHost.get('api-2')!.cpu_avg).toBeCloseTo(0.9, 6);
    expect(byHost.get('api-2')!.cpu_sd).toBeCloseTo(0, 6);
  });

  it('drops a host that has gone fully silent (no samples in the window)', () => {
    const agg = new HostAggregator();
    agg.record('api-1', 0, 0.5);
    agg.record('api-2', 70_000, 0.7);
    // After tick at t=70s, api-1's only sample (t=0) is outside the
    // 1m window, so it should be omitted from the row set entirely.
    const rows = agg.tick(70_000);
    expect(rows.map((r) => r.host)).toEqual(['api-2']);
  });

  it('tick(t) called twice with the same t emits cpu_n=0 the second time (no double-counting)', () => {
    const agg = new HostAggregator();
    agg.record('api-1', 1_000_000, 0.5);
    agg.record('api-1', 1_000_001, 0.5);
    const t1 = agg.tick(1_000_010);
    expect(t1[0].cpu_n).toBe(2);
    // The window data is unchanged but cpu_n was reset, so a duplicate
    // tick at the same boundary reports zero new samples — never the
    // original 2 again. (`startAggregate` additionally guards against
    // the duplicate emission entirely.)
    const t2 = agg.tick(1_000_010);
    expect(t2[0].cpu_n).toBe(0);
  });

  it('survives many ticks under steady-state churn (compaction smoke test)', () => {
    // 30 minutes of samples at 1ms cadence with one tick every 200ms.
    // A naive shift-on-every-trim implementation would O(n²) here; if
    // this finishes in well under a second the lazy compactor is
    // doing its job. We assert only that the math stays coherent.
    const agg = new HostAggregator();
    let now = 0;
    let lastRow = null as ReturnType<HostAggregator['tick']>[number] | null;
    for (let i = 0; i < 18_000; i++) {
      agg.record('api-1', now, 0.5);
      now += 1; // 1 sample per ms
      if (i % 200 === 199) {
        const rows = agg.tick(now);
        if (rows.length > 0) lastRow = rows[0];
      }
    }
    expect(lastRow).not.toBeNull();
    expect(lastRow!.cpu_avg).toBeCloseTo(0.5, 6);
    // Window is 1m at 1 sample/ms; live count converges to 60_000.
    // We don't assert the exact internal length, just that the avg is
    // numerically stable across the 18k ticks.
  });
});

describe('startAggregate tick clock', () => {
  it('does not emit two append frames for the same tick boundary', async () => {
    // Tight 5ms cadence: many ticks fire inside the test window. The
    // monotonic guard in `startAggregate` should ensure every emitted
    // frame has a strictly increasing `ts` even under timer jitter.
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const frames: string[] = [];
    const { stop } = startAggregate(live, (f) => frames.push(f), {
      tickMs: 5,
    });
    try {
      // Push enough events to trigger ticks; 50ms is 10 tick boundaries.
      for (let i = 0; i < 20; i++) {
        live.push([new Date(Date.now() + i), 0.5, 100, 'api-1']);
      }
      await new Promise((res) => setTimeout(res, 80));
      const tickTimes = frames
        .map((f) => JSON.parse(f) as { rows: { ts: number }[] })
        .map((m) => m.rows[0]?.ts)
        .filter((t): t is number => t !== undefined);
      // Strictly monotonic — never equal, never decreasing.
      for (let i = 1; i < tickTimes.length; i++) {
        expect(tickTimes[i]).toBeGreaterThan(tickTimes[i - 1]);
      }
    } finally {
      stop();
    }
  });
});
