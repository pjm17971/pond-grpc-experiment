import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import {
  aggregateSchema,
  type AggregateAppendMsg,
  type AggregateSnapshotMsg,
  type HostTick,
} from '@pond-experiment/shared';
import {
  applyAggregateFrame,
  sumFrameCpuN,
  tickToRow,
} from './useRemoteAggregateSeries';

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
  n_current: cpu_n > 0 ? Math.min(cpu_n, 5) : 0,
  anomalies_above: [0, 0, 0, 0, 0],
  anomalies_below: [0, 0, 0, 0, 0],
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

  it('functional update path: sequential applications never lose state when frames land back-to-back', () => {
    // The hook uses `setLatestPerHost(prev => applyAggregateFrame(prev, msg))`
    // so two frames arriving between commits each see the previous's
    // contribution. Simulate that here by chaining the helper directly.
    let state: ReadonlyMap<string, HostTick> = new Map();
    state = applyAggregateFrame(state, {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_000, 0.5, 2)],
    });
    state = applyAggregateFrame(state, {
      type: 'aggregate-append',
      rows: [mkTick('api-2', 1_200, 0.6, 3)],
    });
    state = applyAggregateFrame(state, {
      type: 'aggregate-append',
      rows: [mkTick('api-3', 1_400, 0.7, 1)],
    });
    expect(state.size).toBe(3);
    expect(state.get('api-1')?.cpu_avg).toBe(0.5);
    expect(state.get('api-2')?.cpu_avg).toBe(0.6);
    expect(state.get('api-3')?.cpu_avg).toBe(0.7);
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

describe('tickToRow', () => {
  it('converts the wire object form to the schema-typed tuple', () => {
    const row = tickToRow({
      ts: 1_700_000_000_000,
      host: 'api-1',
      cpu_avg: 0.55,
      cpu_sd: 0.08,
      cpu_n: 1000,
      n_current: 4,
      anomalies_above: [3, 1, 0, 0, 0],
      anomalies_below: [2, 0, 0, 0, 0],
    });
    expect(row).toEqual([
      1_700_000_000_000,
      'api-1',
      0.55,
      0.08,
      1000,
      4,
      [3, 1, 0, 0, 0],
      [2, 0, 0, 0, 0],
    ]);
  });

  it('preserves nullable cpu_avg / cpu_sd', () => {
    const row = tickToRow({
      ts: 1_700_000_000_000,
      host: 'api-1',
      cpu_avg: null,
      cpu_sd: null,
      cpu_n: 0,
      n_current: 0,
      anomalies_above: [],
      anomalies_below: [],
    });
    expect(row).toEqual([
      1_700_000_000_000,
      'api-1',
      null,
      null,
      0,
      0,
      [],
      [],
    ]);
  });

  it('result pushes cleanly into a real LiveSeries<AggregateSchema>', () => {
    // End-to-end: produce rows from the wire shape, push through
    // pond's runtime validator, read back. Catches drift between
    // the schema's `required` flags and `pushJson`'s acceptance of
    // null cells (the kind of bug that only shows up at runtime).
    const live = new LiveSeries({
      name: 'agg-test',
      schema: aggregateSchema,
      retention: { maxAge: '6m' },
    });
    const ticks: HostTick[] = [
      {
        ts: 1_700_000_000_000,
        host: 'api-1',
        cpu_avg: 0.5,
        cpu_sd: 0.08,
        cpu_n: 50,
        n_current: 5,
        anomalies_above: [4, 1, 0, 0, 0],
        anomalies_below: [0, 0, 0, 0, 0],
      },
      {
        ts: 1_700_000_000_200,
        host: 'api-1',
        cpu_avg: null,
        cpu_sd: null,
        cpu_n: 0,
        n_current: 0,
        anomalies_above: [0, 0, 0, 0, 0],
        anomalies_below: [0, 0, 0, 0, 0],
      },
      {
        ts: 1_700_000_000_400,
        host: 'api-1',
        cpu_avg: 0.6,
        cpu_sd: 0.09,
        cpu_n: 60,
        n_current: 6,
        anomalies_above: [3, 0, 0, 0, 0],
        anomalies_below: [0, 0, 0, 0, 0],
      },
    ];
    expect(() => live.pushJson(ticks.map(tickToRow))).not.toThrow();
    expect(live.length).toBe(3);
    const events = [live.at(0)!, live.at(1)!, live.at(2)!];
    expect(events[0].get('cpu_avg')).toBeCloseTo(0.5, 6);
    expect(events[0].get('n_current')).toBe(5);
    expect(events[0].get('anomalies_above')).toEqual([4, 1, 0, 0, 0]);
    expect(events[1].get('cpu_avg')).toBeUndefined();
    expect(events[1].get('cpu_n')).toBe(0);
    expect(events[2].get('cpu_avg')).toBeCloseTo(0.6, 6);
  });
});

describe('sumFrameCpuN', () => {
  it('sums cpu_n across every row in a frame', () => {
    const msg: AggregateAppendMsg = {
      type: 'aggregate-append',
      rows: [
        mkTick('api-1', 1_000, 0.5, 2),
        mkTick('api-2', 1_000, 0.6, 3),
        mkTick('api-3', 1_000, 0.7, 1),
      ],
    };
    expect(sumFrameCpuN(msg)).toBe(6);
  });

  it('returns zero for an empty frame', () => {
    expect(sumFrameCpuN({ type: 'aggregate-append', rows: [] })).toBe(0);
  });

  it('counts frames with cpu_n=0 (stats present but no new samples this tick)', () => {
    const msg: AggregateAppendMsg = {
      type: 'aggregate-append',
      rows: [mkTick('api-1', 1_000, 0.5, 0), mkTick('api-2', 1_000, 0.6, 0)],
    };
    expect(sumFrameCpuN(msg)).toBe(0);
  });

  it('also works on aggregate-snapshot frames (subsequent steps will ship rows there)', () => {
    const snap: AggregateSnapshotMsg = {
      type: 'aggregate-snapshot',
      thresholds: [1, 2],
      rows: [mkTick('api-1', 900, 0.4, 5)],
    };
    expect(sumFrameCpuN(snap)).toBe(5);
  });
});
