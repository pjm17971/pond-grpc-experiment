import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { LiveSeries } from 'pond-ts';
import {
  schema,
  decode,
  encode,
  type WireMsg,
  type AppendMsg,
  type SnapshotMsg,
  type AggregateAppendMsg,
  type AggregateSnapshotMsg,
  DEFAULT_AGGREGATE_THRESHOLDS,
} from '@pond-experiment/shared';
import {
  startServer,
  projectAppend,
  projectSnapshotHistory,
  parseControlMessage,
  parseConnectQuery,
  type RunningServer,
} from './server.js';
import { recordIngest, type MetricsSnapshot } from './metrics.js';

const mkRow = (host: string, cpu: number | null) => ({
  ts: 1_000,
  host,
  cpu_avg: cpu,
  cpu_sd: 0.05,
  cpu_n: 100,
  n_current: 5,
  anomalies_above: [0, 0, 0, 0, 0],
  anomalies_below: [0, 0, 0, 0, 0],
  requests_avg: 100,
  requests_sum: 6_000,
  requests_n: 100,
  window_age_seconds: 60,
  cpu_min: cpu != null ? cpu - 0.05 : null,
  cpu_max: cpu != null ? cpu + 0.05 : null,
  current_avg: cpu,
  current_sd: cpu != null ? 0.04 : null,
});

/**
 * Tiny prefs helper. Defaults to `cpu_avg` rank metric and `null`
 * hysteresis state so most cases read clean — pass overrides as
 * positional args.
 */
const prefs = (
  topN: number | null,
  lastTopHosts: ReadonlySet<string> | null = null,
  rankBy: 'cpu_avg' | 'cpu_sd' | 'requests_sum' = 'cpu_avg',
) => ({ topN, rankBy, lastTopHosts });

describe('projectAppend (per-subscriber wire projection)', () => {
  const baseMsg: AggregateAppendMsg = {
    type: 'aggregate-append',
    rows: [
      mkRow('api-1', 0.3),
      mkRow('api-2', 0.9),
      mkRow('api-3', 0.5),
      mkRow('api-4', 0.7),
      mkRow('api-5', 0.1),
    ],
    globals: {
      ts: 1_000,
      events_ingested_total: 1000,
      events_per_sec: 50,
      evicted_total: 0,
    },
  };

  it('passes through unchanged when prefs.topN is null', () => {
    const out = projectAppend(baseMsg, prefs(null));
    expect(out.msg).toBe(baseMsg);
    expect(out.lastTopHosts).toBeNull();
  });

  it('passes through unchanged when topN >= row count', () => {
    expect(projectAppend(baseMsg, prefs(5)).msg).toBe(baseMsg);
    expect(projectAppend(baseMsg, prefs(10)).msg).toBe(baseMsg);
    // Everyone-fits path still records the host set so the next
    // call's hysteresis has a non-null reference if rows grow past N.
    const out = projectAppend(baseMsg, prefs(5));
    expect(out.lastTopHosts).not.toBeNull();
    expect(out.lastTopHosts!.size).toBe(5);
    expect(out.lastTopHosts!.has('api-2')).toBe(true);
  });

  it('keeps top-N hosts ranked by cpu_avg, descending', () => {
    const out = projectAppend(baseMsg, prefs(2));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['api-2', 'api-4']);
    expect(out.lastTopHosts).toEqual(new Set(['api-2', 'api-4']));
  });

  it('preserves the rest of the message envelope (globals, type)', () => {
    const out = projectAppend(baseMsg, prefs(3));
    expect(out.msg.type).toBe('aggregate-append');
    expect(out.msg.globals).toBe(baseMsg.globals);
  });

  it('sorts hosts with null cpu_avg to the bottom (would otherwise outrank live hosts)', () => {
    const msg: AggregateAppendMsg = {
      type: 'aggregate-append',
      rows: [
        mkRow('api-1', null),
        mkRow('api-2', 0.4),
        mkRow('api-3', null),
        mkRow('api-4', 0.6),
      ],
    };
    const out = projectAppend(msg, prefs(2));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['api-4', 'api-2']);
  });

  it('returns an empty rows array when topN is 0 (degenerate edge — clamped at parse, but defensive)', () => {
    const out = projectAppend(baseMsg, prefs(0));
    expect(out.msg.rows).toEqual([]);
  });
});

describe('projectAppend hysteresis', () => {
  // Build five hosts at evenly-spaced cpu_avg so the rank order is
  // stable and we can simulate "F sneaks ahead of E" without
  // needing precise floating-point control. Top-5 cut, hysteresis
  // margin 1 (the default).
  const STABLE_RANKING: Array<[string, number]> = [
    ['A', 0.9],
    ['B', 0.8],
    ['C', 0.7],
    ['D', 0.6],
    ['E', 0.5],
    ['F', 0.4],
    ['G', 0.3],
  ];
  const buildMsg = (
    pairs: ReadonlyArray<[string, number]>,
  ): AggregateAppendMsg => ({
    type: 'aggregate-append',
    rows: pairs.map(([h, cpu]) => mkRow(h, cpu)),
  });

  it('margin: 0 disables hysteresis entirely (regression-equivalent to strict top-N)', () => {
    // Edge regime — useful for callers that want strict top-N
    // (the pre-hysteresis behaviour, equivalent to passing 0
    // through). Same input + lastTopHosts as the next test;
    // the only difference is margin=0 vs margin=1.
    const msg = buildMsg([
      ['A', 0.9],
      ['B', 0.8],
      ['C', 0.7],
      ['D', 0.6],
      ['F', 0.55], // F sneaks above E
      ['E', 0.5],
    ]);
    const out = projectAppend(
      msg,
      prefs(5, new Set(['A', 'B', 'C', 'D', 'E'])),
      0,
    );
    expect(out.msg.rows.map((r) => r.host)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'F',
    ]);
    // E is dropped — no carry-over at margin 0.
    expect(out.lastTopHosts).toEqual(new Set(['A', 'B', 'C', 'D', 'F']));
  });

  it('stable state: same hosts every tick, lastTopHosts converges and stays equal', () => {
    // Two consecutive calls with the canonical ranking. The set
    // `{A,B,C,D,E}` is the steady state; the second call should
    // produce an identical set (no drift).
    const msg = buildMsg(STABLE_RANKING);
    const out1 = projectAppend(msg, prefs(5));
    expect(out1.msg.rows.map((r) => r.host)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    const out2 = projectAppend(msg, prefs(5, out1.lastTopHosts));
    expect(out2.msg.rows.map((r) => r.host)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(out2.lastTopHosts).toEqual(out1.lastTopHosts);
  });

  it('single-rank boundary swap: keeps both edge hosts visible (N+1 hosts during churn)', () => {
    // The flicker case the friction note documents. lastTopHosts
    // = `{A,B,C,D,E}` (E was at rank 5). New tick: F sneaks above
    // E, so strict top-5 = `{A,B,C,D,F}`. With margin 1, E (now
    // at rank 6) is in lastTopHosts and inside the [N+1, N+margin]
    // band, so it carries over. Output: 6 hosts, not 5.
    const msg = buildMsg([
      ['A', 0.9],
      ['B', 0.8],
      ['C', 0.7],
      ['D', 0.6],
      ['F', 0.55],
      ['E', 0.5],
      ['G', 0.3],
    ]);
    const out = projectAppend(
      msg,
      prefs(5, new Set(['A', 'B', 'C', 'D', 'E'])),
    );
    expect(out.msg.rows.map((r) => r.host)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'F',
      'E',
    ]);
    // E and F both in the carry; the cut size is N+1 transiently.
    expect(out.lastTopHosts).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F']));
  });

  it('sustained drop: host past rank N+margin expels from cut', () => {
    // F was carried in last frame (cut was {A,B,C,D,E,F}). This
    // frame F drops decisively to rank 7 — outside the [N+1, N+1]
    // carry band, so it's expelled. E recovers to rank 5; cut
    // returns to N=5.
    const msg = buildMsg([
      ['A', 0.9],
      ['B', 0.8],
      ['C', 0.7],
      ['D', 0.6],
      ['E', 0.5],
      ['G', 0.45],
      ['F', 0.3], // dropped
    ]);
    const out = projectAppend(
      msg,
      prefs(5, new Set(['A', 'B', 'C', 'D', 'E', 'F'])),
    );
    expect(out.msg.rows.map((r) => r.host)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(out.lastTopHosts).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
  });

  it('burst entry: new host vaulting from far rank into top-N admits immediately', () => {
    // Hysteresis is one-way (delays expulsion, never delays
    // admission). A host that wasn't in lastTopHosts but is now at
    // rank ≤ N joins the cut on its first tick.
    const msg = buildMsg([
      ['Z', 0.95], // burst from nowhere
      ['A', 0.9],
      ['B', 0.8],
      ['C', 0.7],
      ['D', 0.6],
      ['E', 0.5],
    ]);
    const out = projectAppend(
      msg,
      prefs(5, new Set(['A', 'B', 'C', 'D', 'E'])),
    );
    // Z admitted, E carried (at new rank 6, which is in [N+1, N+1]).
    expect(out.msg.rows.map((r) => r.host)).toEqual([
      'Z',
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
    expect(out.lastTopHosts).toEqual(
      new Set(['Z', 'A', 'B', 'C', 'D', 'E']),
    );
  });

  it('null lastTopHosts (cold start) is strict top-N — hysteresis warms up over the next frame', () => {
    // First frame after connect, or after a `set-top-n` change;
    // no carry-over reference yet. Cut equals strict top-N.
    const msg = buildMsg([
      ['A', 0.9],
      ['B', 0.8],
      ['C', 0.7],
      ['F', 0.55],
      ['E', 0.5],
    ]);
    const out = projectAppend(msg, prefs(3, null));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['A', 'B', 'C']);
    expect(out.lastTopHosts).toEqual(new Set(['A', 'B', 'C']));
  });
});

describe('projectAppend rankBy (configurable sort key)', () => {
  // Mix CPU vs requests so the two metrics produce different rank
  // orders — the test fails loudly if `rankBy` is ignored.
  const mkRankRow = (
    host: string,
    cpu_avg: number | null,
    requests_sum: number,
    requests_avg: number | null = null,
    cpu_sd: number | null = 0.05,
  ) => ({
    ...mkRow(host, cpu_avg),
    requests_sum,
    // Carry an explicit requests_avg too — the disagreement test
    // below uses it to prove that ranking by `requests_sum` doesn't
    // accidentally fall back to `requests_avg`.
    requests_avg: requests_avg ?? requests_sum / 60,
    cpu_sd,
  });

  // Three hosts where CPU rank and requests rank disagree, so any of
  // the three rank metrics produces a different ordering. cpu_sd is
  // also varied so it produces yet a third rank order.
  const mixedMsg: AggregateAppendMsg = {
    type: 'aggregate-append',
    rows: [
      mkRankRow('hot-cpu', 0.9, 100, null, 0.02),
      mkRankRow('hot-req', 0.4, 500, null, 0.05),
      mkRankRow('hot-vol', 0.5, 200, null, 0.2),
    ],
  };

  it('rankBy: cpu_avg (default) ranks by 1m baseline CPU', () => {
    const out = projectAppend(mixedMsg, prefs(2, null, 'cpu_avg'));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['hot-cpu', 'hot-vol']);
  });

  it('rankBy: requests_sum ranks by 1m baseline total request count', () => {
    const out = projectAppend(mixedMsg, prefs(2, null, 'requests_sum'));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['hot-req', 'hot-vol']);
  });

  it('rankBy: cpu_sd ranks by 1m baseline volatility', () => {
    const out = projectAppend(mixedMsg, prefs(2, null, 'cpu_sd'));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['hot-vol', 'hot-req']);
  });

  it('rankBy: requests_sum is throughput, not mean — disagreement with requests_avg', () => {
    // The PR-#37 review caught this: a "1m req/s" rank that uses
    // pond's `requests_avg` (mean request count per event) produces
    // a fundamentally wrong order. This test pins the fix:
    //
    //   - `whale`: 5 events × 200 requests each = sum 1000, avg 200
    //   - `swarm`: 5000 events × 1 request each = sum 5000, avg 1
    //
    // `whale` has higher `requests_avg`. `swarm` has higher
    // `requests_sum` (and is the genuinely busier host). Ranking by
    // `requests_sum` puts `swarm` first; ranking by `requests_avg`
    // would put `whale` first.
    const msg: AggregateAppendMsg = {
      type: 'aggregate-append',
      rows: [
        mkRankRow('whale', 0.5, 1_000, 200),
        mkRankRow('swarm', 0.5, 5_000, 1),
      ],
    };
    const out = projectAppend(msg, prefs(1, null, 'requests_sum'));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['swarm']);
  });

  it('null values on the rank column sort to the bottom (cold-start hosts last)', () => {
    // `cpu_avg` is nullable per the HostTick schema (rolling-baseline
    // reducer returns null for an empty 1m window). A host with
    // null `cpu_avg` should rank below any host with a numeric
    // value — the cold-start case where a host just connected and
    // hasn't accumulated baseline samples yet.
    const msg: AggregateAppendMsg = {
      type: 'aggregate-append',
      rows: [
        mkRankRow('cold', null, 100),
        mkRankRow('mid', 0.5, 100),
        mkRankRow('low', 0.4, 100),
      ],
    };
    const out = projectAppend(msg, prefs(2, null, 'cpu_avg'));
    expect(out.msg.rows.map((r) => r.host)).toEqual(['mid', 'low']);
  });

  it('hysteresis carries across the same rank metric (not auto-reset)', () => {
    // Stable cut by requests_sum; second call with the same metric
    // and a populated lastTopHosts should preserve the carry-over
    // path. The set-top-n handler is responsible for resetting on
    // metric change — projectAppend itself is stateless about that.
    const out1 = projectAppend(mixedMsg, prefs(2, null, 'requests_sum'));
    const out2 = projectAppend(
      mixedMsg,
      prefs(2, out1.lastTopHosts, 'requests_sum'),
    );
    expect(out2.msg.rows.map((r) => r.host)).toEqual(out1.msg.rows.map((r) => r.host));
  });
});

describe('parseControlMessage', () => {
  it('parses a valid set-top-n message (no `by` field → rankBy undefined for caller-side merge)', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n', n: 5 }), 80)).toEqual(
      { topN: 5, rankBy: undefined },
    );
  });

  it('accepts n: null as "clear filter"', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n', n: null }), 80)).toEqual(
      { topN: null, rankBy: undefined },
    );
  });

  it('clamps below 1 to 1', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n', n: 0 }), 80)).toEqual(
      { topN: 1, rankBy: undefined },
    );
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n', n: -5 }), 80)).toEqual(
      { topN: 1, rankBy: undefined },
    );
  });

  it('clamps above max(hostCount, 1000) to that ceiling', () => {
    expect(
      parseControlMessage(JSON.stringify({ type: 'set-top-n', n: 5000 }), 80),
    ).toEqual({ topN: 1000, rankBy: undefined });
    expect(
      parseControlMessage(JSON.stringify({ type: 'set-top-n', n: 5000 }), 2000),
    ).toEqual({ topN: 2000, rankBy: undefined });
  });

  it('floors fractional n', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n', n: 7.9 }), 80)).toEqual(
      { topN: 7, rankBy: undefined },
    );
  });

  it('accepts and validates the `by` field', () => {
    expect(
      parseControlMessage(
        JSON.stringify({ type: 'set-top-n', n: 5, by: 'cpu_avg' }),
        80,
      ),
    ).toEqual({ topN: 5, rankBy: 'cpu_avg' });
    expect(
      parseControlMessage(
        JSON.stringify({ type: 'set-top-n', n: 5, by: 'requests_sum' }),
        80,
      ),
    ).toEqual({ topN: 5, rankBy: 'requests_sum' });
    expect(
      parseControlMessage(
        JSON.stringify({ type: 'set-top-n', n: 5, by: 'cpu_sd' }),
        80,
      ),
    ).toEqual({ topN: 5, rankBy: 'cpu_sd' });
  });

  it('rejects an unknown `by` value (rather than silently ignoring it)', () => {
    // Hard reject so a client typo surfaces. The alternative — drop
    // the `by` field and accept the message — would let a typo
    // silently leave the cut on whatever metric was previously set.
    expect(
      parseControlMessage(
        JSON.stringify({ type: 'set-top-n', n: 5, by: 'cpu_argh' }),
        80,
      ),
    ).toBeNull();
    expect(
      parseControlMessage(
        JSON.stringify({ type: 'set-top-n', n: 5, by: 42 }),
        80,
      ),
    ).toBeNull();
  });

  it('accepts `by` together with `n: null` (clear filter + change metric in one msg)', () => {
    expect(
      parseControlMessage(
        JSON.stringify({ type: 'set-top-n', n: null, by: 'requests_sum' }),
        80,
      ),
    ).toEqual({ topN: null, rankBy: 'requests_sum' });
  });

  it('returns null on invalid input rather than throwing', () => {
    expect(parseControlMessage('not json', 80)).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'other' }), 80)).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n' }), 80)).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'set-top-n', n: 'five' }), 80)).toBeNull();
    expect(parseControlMessage(JSON.stringify(null), 80)).toBeNull();
    expect(parseControlMessage(42, 80)).toBeNull();
    // Note: `JSON.stringify({n: NaN})` serialises NaN as `null` —
    // a quirk of the JSON spec — so the message arrives equivalent
    // to `{type:'set-top-n', n: null}` and is treated as
    // "clear filter," not invalid. That's the right semantic at
    // the wire layer; if a JS client wanted to send a real NaN to
    // signal an error, it'd need its own wrapper.
  });
});

describe('parseConnectQuery (snapshot-time projection hint)', () => {
  // The dashboard ships `?n=&by=` query params on the WS handshake
  // URL so the server can apply the per-subscriber projection to
  // the snapshot backfill. Defaults are the back-compat shape
  // (`topN: null`, `rankBy: 'cpu_avg'`) for older clients that
  // don't send them.

  it('returns the no-filter default for an empty / missing URL', () => {
    expect(parseConnectQuery(undefined)).toEqual({
      topN: null,
      rankBy: 'cpu_avg',
    });
    expect(parseConnectQuery('/live-agg')).toEqual({
      topN: null,
      rankBy: 'cpu_avg',
    });
  });

  it('parses `?n=5&by=cpu_avg`', () => {
    expect(parseConnectQuery('/live-agg?n=5&by=cpu_avg')).toEqual({
      topN: 5,
      rankBy: 'cpu_avg',
    });
  });

  it('clamps n to [1, 1000]', () => {
    expect(parseConnectQuery('/live-agg?n=0').topN).toBe(1);
    expect(parseConnectQuery('/live-agg?n=-5').topN).toBe(1);
    expect(parseConnectQuery('/live-agg?n=5000').topN).toBe(1000);
    expect(parseConnectQuery('/live-agg?n=7.9').topN).toBe(7);
  });

  it('falls back to no-filter on non-finite n', () => {
    expect(parseConnectQuery('/live-agg?n=NaN').topN).toBeNull();
    expect(parseConnectQuery('/live-agg?n=foo').topN).toBeNull();
    expect(parseConnectQuery('/live-agg?n=').topN).toBeNull();
  });

  it('accepts each known rank key', () => {
    expect(parseConnectQuery('/live-agg?by=cpu_avg').rankBy).toBe('cpu_avg');
    expect(parseConnectQuery('/live-agg?by=cpu_sd').rankBy).toBe('cpu_sd');
    expect(parseConnectQuery('/live-agg?by=requests_sum').rankBy).toBe(
      'requests_sum',
    );
  });

  it('falls back to cpu_avg on unknown / missing rank key (no hard reject)', () => {
    // Distinct from `parseControlMessage`'s hard reject — query
    // strings come from URL bars and may be hand-edited; quietly
    // defaulting is a better UX than refusing the connection.
    expect(parseConnectQuery('/live-agg?by=cpu_argh').rankBy).toBe('cpu_avg');
    expect(parseConnectQuery('/live-agg?by=').rankBy).toBe('cpu_avg');
  });

  it('combines params: `?n=3&by=requests_sum`', () => {
    expect(parseConnectQuery('/live-agg?n=3&by=requests_sum')).toEqual({
      topN: 3,
      rankBy: 'requests_sum',
    });
  });
});

describe('projectSnapshotHistory', () => {
  // The ts-grouped projection that closes the PR-#37 review
  // finding: snapshot replay was being shipped unfiltered, so
  // every connect/reconnect briefly delivered the full host
  // history regardless of the client's top-N preference. With
  // `parseConnectQuery` reading the prefs at handshake time and
  // this helper projecting the snapshot rows per-tick, the cut
  // is applied to history too.

  const ts = (n: number): number => 1_000_000 + n * 200;

  // Build a small flat history: 3 ticks × 4 hosts, ts-then-host
  // ordered. cpu_avg picked so api-1 is always #1, api-2 is #2,
  // etc. — strict top-N produces a predictable ordering.
  const flatRows: ReturnType<typeof mkRow>[] = [];
  for (let t = 0; t < 3; t++) {
    flatRows.push({ ...mkRow('api-1', 0.9), ts: ts(t) });
    flatRows.push({ ...mkRow('api-2', 0.8), ts: ts(t) });
    flatRows.push({ ...mkRow('api-3', 0.7), ts: ts(t) });
    flatRows.push({ ...mkRow('api-4', 0.6), ts: ts(t) });
  }

  it('passes through unchanged when topN is null (no filter)', () => {
    const out = projectSnapshotHistory(flatRows, prefs(null));
    expect(out.rows.length).toBe(flatRows.length);
    expect(out.lastTopHosts).toBeNull();
  });

  it('cuts each tick to the top-N hosts (PR-#37 finding fix)', () => {
    const out = projectSnapshotHistory(flatRows, prefs(2));
    // 3 ticks × 2 hosts each = 6 rows out (vs 12 in).
    expect(out.rows.length).toBe(6);
    // Every tick keeps only api-1 and api-2.
    const hostsByTs = new Map<number, Set<string>>();
    for (const r of out.rows) {
      let s = hostsByTs.get(r.ts);
      if (!s) {
        s = new Set();
        hostsByTs.set(r.ts, s);
      }
      s.add(r.host);
    }
    for (const [, hosts] of hostsByTs) {
      expect(hosts).toEqual(new Set(['api-1', 'api-2']));
    }
  });

  it('returns final hysteresis state so live frames continue from snapshot tail', () => {
    // After projecting the snapshot, the returned `lastTopHosts`
    // should equal the host set the final tick shipped — which
    // the caller writes back into `ClientPrefs` so the first
    // live frame's hysteresis decides carry-overs against the
    // snapshot's tail rather than against an empty set.
    const out = projectSnapshotHistory(flatRows, prefs(2));
    expect(out.lastTopHosts).toEqual(new Set(['api-1', 'api-2']));
  });

  it('threads hysteresis across snapshot ticks (boundary host carries over)', () => {
    // Build a 2-tick history where api-3 leads at tick 0 but
    // api-4 sneaks ahead at tick 1 (api-3's cpu_avg drops). With
    // topN=3 and margin 1, api-3 should carry over at tick 1
    // even though it's now rank-4.
    const rows: ReturnType<typeof mkRow>[] = [
      { ...mkRow('api-1', 0.9), ts: ts(0) },
      { ...mkRow('api-2', 0.8), ts: ts(0) },
      { ...mkRow('api-3', 0.7), ts: ts(0) },
      { ...mkRow('api-4', 0.5), ts: ts(0) },
      // tick 1 — api-3 drops to rank 4
      { ...mkRow('api-1', 0.9), ts: ts(1) },
      { ...mkRow('api-2', 0.8), ts: ts(1) },
      { ...mkRow('api-4', 0.7), ts: ts(1) },
      { ...mkRow('api-3', 0.6), ts: ts(1) },
    ];
    const out = projectSnapshotHistory(rows, prefs(3));
    // tick 0: top-3 strict = api-1, api-2, api-3.
    // tick 1: top-3 strict = api-1, api-2, api-4. api-3 was in
    // last cut, new rank 4 ≤ 3 + 1 = within margin → carries.
    // So tick 1 ships 4 rows.
    const tick0 = out.rows.filter((r) => r.ts === ts(0)).map((r) => r.host);
    const tick1 = out.rows.filter((r) => r.ts === ts(1)).map((r) => r.host);
    expect(new Set(tick0)).toEqual(new Set(['api-1', 'api-2', 'api-3']));
    expect(new Set(tick1)).toEqual(
      new Set(['api-1', 'api-2', 'api-4', 'api-3']),
    );
  });
});


describe('wire codec', () => {
  it('roundtrips a snapshot frame', () => {
    const msg: WireMsg = {
      type: 'snapshot',
      rows: [[1700000000000, 0.5, 100, 'api-1']],
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it('roundtrips an append frame with multiple rows', () => {
    const msg: WireMsg = {
      type: 'append',
      rows: [
        [1700000000000, 0.5, 100, 'api-1'],
        [1700000000050, 0.6, 110, 'api-2'],
      ],
    };
    expect(decode(encode(msg))).toEqual(msg);
  });
});

describe('server WS protocol', () => {
  let live: LiveSeries<typeof schema>;
  let server: RunningServer;
  let port: number;

  beforeEach(async () => {
    live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    // Random port avoids conflicts with parallel test runs.
    port = 9100 + Math.floor(Math.random() * 800);
    server = await startServer({ port, host: '127.0.0.1', live });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('sends a snapshot frame on connect, then append frames per batch', async () => {
    // Pre-populate so the snapshot isn't empty.
    live.push([new Date(1_700_000_000_000), 0.5, 100, 'api-1']);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const received: WireMsg[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for 2 messages')),
        2000,
      );
      ws.on('error', reject);
      ws.on('message', (data) => {
        received.push(decode(data.toString()));
        if (received.length === 2) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on('open', () => {
        // Push after open so the batch fires as an append, not folded
        // into the snapshot.
        setTimeout(() => {
          live.push([new Date(1_700_000_000_050), 0.6, 150, 'api-2']);
        }, 50);
      });
    });

    ws.close();

    const [snap, app] = received as [SnapshotMsg, AppendMsg];
    expect(snap.type).toBe('snapshot');
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0][2]).toBe(100);
    expect(snap.rows[0][3]).toBe('api-1');

    expect(app.type).toBe('append');
    expect(app.rows).toHaveLength(1);
    expect(app.rows[0][2]).toBe(150);
    expect(app.rows[0][3]).toBe('api-2');
  });

  it('broadcasts append frames to multiple connected clients', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const r1: WireMsg[] = [];
    const r2: WireMsg[] = [];
    // Attach listeners synchronously so neither snapshot is missed.
    ws1.on('message', (d) => r1.push(decode(d.toString())));
    ws2.on('message', (d) => r2.push(decode(d.toString())));

    await Promise.all([
      new Promise<void>((res, rej) => {
        ws1.on('open', () => res());
        ws1.on('error', rej);
      }),
      new Promise<void>((res, rej) => {
        ws2.on('open', () => res());
        ws2.on('error', rej);
      }),
    ]);

    // Wait for both clients to receive their snapshot.
    await waitForCount(r1, 1);
    await waitForCount(r2, 1);

    live.push([new Date(), 0.7, 200, 'api-3']);

    // Each client should see snapshot (1) + append (1) = 2 frames.
    await waitForCount(r1, 2);
    await waitForCount(r2, 2);

    ws1.close();
    ws2.close();

    // Index 0 is snapshot (empty), index 1 is the append.
    expect(r1[1].type).toBe('append');
    expect(r2[1].type).toBe('append');
    expect((r1[1] as AppendMsg).rows[0][3]).toBe('api-3');
    expect((r2[1] as AppendMsg).rows[0][3]).toBe('api-3');
  });
});

describe('/live-agg WS (M3.5 aggregate stream)', () => {
  let live: LiveSeries<typeof schema>;
  let server: RunningServer;
  let port: number;

  beforeEach(async () => {
    live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    port = 9300 + Math.floor(Math.random() * 600);
    // Tight tick cadence keeps the test fast; the production default
    // is 200ms.
    server = await startServer({
      port,
      host: '127.0.0.1',
      live,
      aggregateTickMs: 50,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('sends an aggregate-snapshot frame on connect, then aggregate-append per tick', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live-agg`);
    const received: WireMsg[] = [];
    ws.on('message', (d) => received.push(decode(d.toString())));

    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => resolve());
    });

    // Push samples spanning multiple 50ms tick boundaries — the
    // clock trigger is data-driven (it fires on event timestamps
    // crossing boundaries, not wall-clock), so we need to span
    // boundaries to trigger emission.
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      live.push([new Date(t0 + i * 30), 0.4 + (i % 3) * 0.1, 100, 'api-1']);
    }

    // Wait for the snapshot + at least one append.
    await waitForCount(received, 2);

    ws.close();

    const snap = received[0] as AggregateSnapshotMsg;
    expect(snap.type).toBe('aggregate-snapshot');
    expect(snap.thresholds).toEqual(DEFAULT_AGGREGATE_THRESHOLDS);
    // Step 8: snapshot may carry history. Connecting immediately
    // after server start means the history ring is usually empty,
    // but a tick boundary that fires between server start and the
    // WS handshake can populate it. Either is correct — assert the
    // shape, not the length.
    expect(Array.isArray(snap.rows)).toBe(true);

    const append = received.find(
      (m) => m.type === 'aggregate-append',
    ) as AggregateAppendMsg | undefined;
    expect(append).toBeDefined();
    expect(append!.rows.length).toBeGreaterThanOrEqual(1);
    const apiOne = append!.rows.find((r) => r.host === 'api-1');
    expect(apiOne).toBeDefined();
    expect(typeof apiOne!.cpu_avg).toBe('number');
    expect(typeof apiOne!.cpu_sd).toBe('number');
    expect(apiOne!.cpu_n).toBeGreaterThanOrEqual(1);
  });

  it('does not interfere with the existing /live raw firehose', async () => {
    const wsRaw = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const wsAgg = new WebSocket(`ws://127.0.0.1:${port}/live-agg`);
    const rawRecv: WireMsg[] = [];
    const aggRecv: WireMsg[] = [];
    wsRaw.on('message', (d) => rawRecv.push(decode(d.toString())));
    wsAgg.on('message', (d) => aggRecv.push(decode(d.toString())));

    await Promise.all([
      new Promise<void>((res, rej) => {
        wsRaw.on('open', () => res());
        wsRaw.on('error', rej);
      }),
      new Promise<void>((res, rej) => {
        wsAgg.on('open', () => res());
        wsAgg.on('error', rej);
      }),
    ]);
    await waitForCount(rawRecv, 1);
    await waitForCount(aggRecv, 1);

    // Push samples spanning boundaries so the clock trigger fires.
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      live.push([new Date(t0 + i * 30), 0.7, 200, 'api-x']);
    }
    // Raw side should see the append; agg side should see at least
    // one tick frame.
    await waitForCount(rawRecv, 2);
    await waitForCount(aggRecv, 2);

    wsRaw.close();
    wsAgg.close();

    expect(rawRecv[0].type).toBe('snapshot');
    expect(rawRecv[1].type).toBe('append');
    expect(aggRecv[0].type).toBe('aggregate-snapshot');
    expect(aggRecv.slice(1).every((m) => m.type === 'aggregate-append')).toBe(
      true,
    );
  });
});

describe('GET /metrics', () => {
  let live: LiveSeries<typeof schema>;
  let server: RunningServer;
  let port: number;

  beforeEach(async () => {
    live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    port = 9900 + Math.floor(Math.random() * 80);
    server = await startServer({ port, host: '127.0.0.1', live });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('FIFO-pairs same-(host, timeMs) collisions in the arrival map', async () => {
    // The producer simulator (post M3 stagger removal) emits all
    // hosts at the same tick `Date.now()`; under setInterval jitter
    // the same `(host, timeMs)` can also appear across ticks within
    // the same wall-clock ms. Verify that two identical-key
    // recordIngest calls each get paired to one fanout via FIFO.
    const probe = new WebSocket(`ws://127.0.0.1:${port}/live`);
    await new Promise<void>((res, rej) => {
      probe.on('open', () => res());
      probe.on('error', rej);
    });

    const before = (await fetchMetrics(port)).latency.ingestToFanoutMs?.count ?? 0;

    // Two events for the same (host, timeMs), pushed one after the
    // other. The map keys collide; FIFO pairing means both should
    // produce a histogram sample.
    const tCollide = Date.now() + 1000;
    recordIngest('api-collide', tCollide);
    recordIngest('api-collide', tCollide);
    live.push([new Date(tCollide), 0.5, 100, 'api-collide']);
    live.push([new Date(tCollide), 0.6, 110, 'api-collide']);

    await new Promise((res) => setTimeout(res, 100));

    const after = (await fetchMetrics(port)).latency.ingestToFanoutMs?.count ?? 0;
    // Both events should have produced histogram samples.
    expect(after - before).toBeGreaterThanOrEqual(2);

    probe.close();
  });

  async function fetchMetrics(p: number): Promise<MetricsSnapshot> {
    const r = await fetch(`http://127.0.0.1:${p}/metrics`);
    return (await r.json()) as MetricsSnapshot;
  }

  it('reports event counters, latency histogram, memory, and ws state', async () => {
    // Connect a probe so the fanout has someone to send to (otherwise
    // bytesFannedOut stays 0 and the ws.clientCount assertion fails).
    const probe = new WebSocket(`ws://127.0.0.1:${port}/live`);
    await new Promise<void>((res, rej) => {
      probe.on('open', () => res());
      probe.on('error', rej);
    });

    // Simulate two events through the ingest path: recordIngest tags
    // arrival, live.push triggers the fanout's recordFanout which
    // records the latency sample.
    const t0 = Date.now();
    recordIngest('api-1', t0);
    live.push([new Date(t0), 0.5, 100, 'api-1']);
    recordIngest('api-2', t0 + 1);
    live.push([new Date(t0 + 1), 0.6, 110, 'api-2']);

    // Wait for pond's batch listener to fire (microtask-deferred).
    await new Promise((res) => setTimeout(res, 100));

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as MetricsSnapshot;

    // The two ingest calls and at least the two events through fanout
    // should be reflected. Other tests in this file also run through
    // the fanout and increment these counters, so use >= rather than
    // ==.
    expect(m.events.ingested).toBeGreaterThanOrEqual(2);
    expect(m.events.fannedOut).toBeGreaterThanOrEqual(2);
    expect(m.events.bytesFannedOut).toBeGreaterThan(0);

    // Latency histogram has the two samples we just submitted.
    expect(m.latency.ingestToFanoutMs).not.toBeNull();
    expect(m.latency.ingestToFanoutMs!.count).toBeGreaterThanOrEqual(2);
    expect(m.latency.ingestToFanoutMs!.p50).toBeGreaterThanOrEqual(0);
    expect(m.latency.ingestToFanoutMs!.p95).toBeGreaterThanOrEqual(
      m.latency.ingestToFanoutMs!.p50,
    );
    expect(m.latency.ingestToFanoutMs!.p99).toBeGreaterThanOrEqual(
      m.latency.ingestToFanoutMs!.p95,
    );

    // WS state: one connected client tracked.
    expect(m.ws.clientCount).toBe(1);
    expect(m.ws.bufferedAmount).toHaveLength(1);

    // Memory snapshot has the standard fields.
    expect(m.memory.rss).toBeGreaterThan(0);
    expect(m.memory.heapUsed).toBeGreaterThan(0);

    // GC bucket structure exists; entries appear over time, may be 0
    // at this point — the existence shape is the assertion, not the
    // count.
    expect(typeof m.gc).toBe('object');

    // LiveSeries length matches the two events pushed.
    expect(m.liveSeriesLength).toBe(2);

    probe.close();
  });
});

function waitForCount(arr: unknown[], n: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (arr.length >= n) resolve();
      else if (Date.now() > deadline)
        reject(new Error(`waited ${timeoutMs}ms for ${n} items, got ${arr.length}`));
      else setTimeout(tick, 10);
    };
    tick();
  });
}
