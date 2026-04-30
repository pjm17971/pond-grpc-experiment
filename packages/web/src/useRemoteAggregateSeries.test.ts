import { describe, it, expect } from 'vitest';
import type {
  AggregateAppendMsg,
  AggregateSnapshotMsg,
  HostTick,
} from '@pond-experiment/shared';
import { applyAggregateFrame } from './useRemoteAggregateSeries';

const mkTick = (
  host: string,
  ts: number,
  cpu_avg: number,
  cpu_n: number,
): HostTick => ({
  ts,
  host,
  cpu_avg,
  cpu_sd: 0.05,
  cpu_n,
});

describe('applyAggregateFrame', () => {
  it('starts empty and grows on the first append frame', () => {
    const empty = new Map<string, HostTick>();
    const append: AggregateAppendMsg = {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_000, 0.5, 2), mkTick('api-2', 1_000, 0.6, 3)],
    };
    const next = applyAggregateFrame(empty, append);
    expect(next.size).toBe(2);
    expect(next.get('api-1')?.cpu_avg).toBe(0.5);
    expect(next.get('api-2')?.cpu_n).toBe(3);
  });

  it('overwrites the per-host entry with the most recent tick', () => {
    const t0 = applyAggregateFrame(new Map(), {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_000, 0.5, 2)],
    });
    const t1 = applyAggregateFrame(t0, {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_200, 0.7, 4)],
    });
    expect(t1.get('api-1')?.ts).toBe(1_200);
    expect(t1.get('api-1')?.cpu_avg).toBe(0.7);
    expect(t1.size).toBe(1);
  });

  it('returns the same map reference when the append has no rows (no re-render churn)', () => {
    const t0 = applyAggregateFrame(new Map(), {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_000, 0.5, 2)],
    });
    const t1 = applyAggregateFrame(t0, {
      type: 'aggregate-append',
      rows: [],
    });
    expect(t1).toBe(t0);
  });

  it('treats an aggregate-snapshot frame the same as an append for the latest map', () => {
    // Step 1 always sends an empty snapshot, but the type permits
    // backfill rows in subsequent steps. Either way the per-host
    // latest-tick map should reflect the snapshot's rows.
    const snap: AggregateSnapshotMsg = {
      type: 'aggregate-snapshot',
      thresholds: [1, 1.5, 2, 2.5, 3],
      rows: [mkTick('api-1', 900, 0.4, 0), mkTick('api-2', 900, 0.6, 0)],
    };
    const next = applyAggregateFrame(new Map(), snap);
    expect(next.size).toBe(2);
    expect(next.get('api-1')?.ts).toBe(900);
    expect(next.get('api-2')?.cpu_avg).toBe(0.6);
  });

  it('preserves entries for hosts not mentioned in the new frame', () => {
    // Sparse-tick regime: at low rates a tick can carry rows for only
    // some hosts. The map should keep the previous value for the
    // omitted ones, not erase them — the dashboard's "host went silent
    // briefly" presentation is the staleness column showing a growing
    // age, not a vanishing row.
    const t0 = applyAggregateFrame(new Map(), {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_000, 0.5, 2), mkTick('api-2', 1_000, 0.6, 3)],
    });
    const t1 = applyAggregateFrame(t0, {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_200, 0.55, 2)],
    });
    expect(t1.size).toBe(2);
    expect(t1.get('api-1')?.ts).toBe(1_200);
    // api-2 retained, not erased.
    expect(t1.get('api-2')?.ts).toBe(1_000);
    expect(t1.get('api-2')?.cpu_avg).toBe(0.6);
  });
});
