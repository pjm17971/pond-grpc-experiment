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
  // Step 5 — requests stats. Default to derived plausible values
  // for tests that don't specifically exercise the requests
  // pass-through (avg=100 matches the producer's constant); tests
  // can override per-row when they care.
  requests_avg: cpu_n > 0 ? 100 : null,
  requests_sum: cpu_n * 100,
  requests_n: cpu_n,
  // Step 6 — window_age_seconds. Default to 60 (warm aggregator).
  window_age_seconds: 60,
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
      requests_avg: 102.5,
      requests_sum: 102_500,
      requests_n: 1000,
      window_age_seconds: 60,
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
      102.5,
      102_500,
      1000,
      60,
    ]);
  });

  it('preserves nullable cpu_avg / cpu_sd / requests_avg', () => {
    const row = tickToRow({
      ts: 1_700_000_000_000,
      host: 'api-1',
      cpu_avg: null,
      cpu_sd: null,
      cpu_n: 0,
      n_current: 0,
      anomalies_above: [],
      anomalies_below: [],
      requests_avg: null,
      requests_sum: 0,
      requests_n: 0,
      window_age_seconds: 0,
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
      null,
      0,
      0,
      0,
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
        requests_avg: 100,
        requests_sum: 5_000,
        requests_n: 50,
        window_age_seconds: 30,
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
        requests_avg: null,
        requests_sum: 0,
        requests_n: 0,
        window_age_seconds: 30.2,
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
        requests_avg: 105,
        requests_sum: 6_300,
        requests_n: 60,
        window_age_seconds: 30.4,
      },
    ];
    expect(() => live.pushJson(ticks.map(tickToRow))).not.toThrow();
    expect(live.length).toBe(3);
    const events = [live.at(0)!, live.at(1)!, live.at(2)!];

    // Spot-checks on the first/middle/last events.
    expect(events[0].get('cpu_avg')).toBeCloseTo(0.5, 6);
    expect(events[0].get('n_current')).toBe(5);
    expect(events[0].get('anomalies_above')).toEqual([4, 1, 0, 0, 0]);
    expect(events[1].get('cpu_avg')).toBeUndefined();
    expect(events[1].get('cpu_n')).toBe(0);
    expect(events[2].get('cpu_avg')).toBeCloseTo(0.6, 6);

    // Every column round-trips with a non-default value. Cheap
    // insurance against schema/converter drift as columns accumulate
    // step-by-step — `tickToRow` is positional, so a missing slot or
    // a misaligned tuple sends wrong data without any type error.
    // (Spotted in PR #25 review: two N-column tuples in lockstep,
    // easy to drift; assert across the whole shape so any future
    // mismatch fails loudly.)
    const first = events[0];
    const last = events[2];
    expect(first.get('host')).toBe('api-1');
    expect(first.get('cpu_sd')).toBeCloseTo(0.08, 6);
    expect(first.get('cpu_n')).toBe(50);
    expect(first.get('anomalies_below')).toEqual([0, 0, 0, 0, 0]);
    expect(first.get('requests_avg')).toBe(100);
    expect(first.get('requests_sum')).toBe(5_000);
    expect(first.get('requests_n')).toBe(50);
    expect(first.get('window_age_seconds')).toBe(30);
    expect(last.get('cpu_sd')).toBeCloseTo(0.09, 6);
    expect(last.get('cpu_n')).toBe(60);
    expect(last.get('n_current')).toBe(6);
    expect(last.get('anomalies_above')).toEqual([3, 0, 0, 0, 0]);
    expect(last.get('requests_avg')).toBe(105);
    expect(last.get('requests_sum')).toBe(6_300);
    expect(last.get('requests_n')).toBe(60);
    expect(last.get('window_age_seconds')).toBeCloseTo(30.4, 6);

    // The middle-row null cells: confirm undefined (not 0/NaN) for
    // nullable columns when the wire shipped null, and 0 for
    // sum-of-empty.
    expect(events[1].get('cpu_sd')).toBeUndefined();
    expect(events[1].get('requests_avg')).toBeUndefined();
    expect(events[1].get('requests_sum')).toBe(0);
    expect(events[1].get('requests_n')).toBe(0);
    expect(events[1].get('window_age_seconds')).toBeCloseTo(30.2, 6);
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
