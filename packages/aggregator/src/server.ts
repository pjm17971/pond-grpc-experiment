import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { type LiveSeries } from 'pond-ts';
import {
  type AggregateAppendMsg,
  type AggregateSnapshotMsg,
  type HostTick,
  type RankKey,
  type Schema,
  DEFAULT_AGGREGATE_THRESHOLDS,
  encode,
} from '@pond-experiment/shared';
import { buildSnapshot } from './snapshot.js';
import { startFanout } from './fanout.js';
import { startAggregate } from './aggregate.js';
import { recordBytesSent, snapshot as metricsSnapshot } from './metrics.js';

/**
 * Per-`/live-agg`-client preferences. Drives **per-subscriber wire
 * projection** at broadcast time — the broadcast loop iterates these
 * and ships a per-client view of each `aggregate-append` frame
 * rather than the same all-hosts payload to everyone.
 *
 * `topN: null` (the default) ships every host's row, matching the
 * pre-control-channel behaviour and keeping older clients
 * compatible. The dashboard sends a `{type:'set-top-n', n}` control
 * message after WS open to enable filtering — see WIRE.md and the
 * matching `useRemoteAggregateSeries` send-on-open path.
 *
 * `lastTopHosts` carries hysteresis state across consecutive frames
 * so a boundary-rank host (just above / just below #topN by a few
 * cpu_avg basis points) doesn't flicker in and out of the cut at
 * 5 Hz. See `projectAppend` for the algorithm; null when there's no
 * filter to remember (`topN === null`) or after a `set-top-n`
 * (every config change starts a fresh cut, see the control-channel
 * handler below).
 */
/**
 * Runtime list of allowed rank-by keys. Used by `parseControlMessage`
 * to validate the wire's `by` field. Stays in lockstep with the
 * `RankKey` type imported from `@pond-experiment/shared` — when
 * adding a metric, both lists need to grow.
 */
const RANK_KEYS: ReadonlyArray<RankKey> = ['cpu_avg', 'cpu_sd', 'requests_sum'];

type ClientPrefs = {
  /** `null` = no filter (ship all rows). Numeric = top-N by `rankBy`. */
  topN: number | null;
  /**
   * Sort key for the top-N cut. Server-side default `cpu_avg`, also
   * the value the dashboard sends explicitly on connect. Switching
   * via `set-top-n` resets `lastTopHosts: null` so hysteresis on
   * the new metric warms up from cold rather than carrying entries
   * sized for the old metric's rank order.
   */
  rankBy: RankKey;
  /**
   * Hysteresis state — the host set the previous frame's projection
   * shipped. `null` for first frame, or after a `set-top-n` that
   * changed the cut depth or metric.
   */
  lastTopHosts: ReadonlySet<string> | null;
};

/**
 * Hysteresis margin (in ranks) for the top-N cut. A host that was
 * in last frame's cut stays in this frame's cut as long as its new
 * rank is `≤ topN + TOP_N_HYSTERESIS_MARGIN`. With margin 1, the
 * visible cut grows to up to N+1 hosts during boundary churn and
 * settles back to N when one host drops decisively (rank > N+1) or
 * climbs decisively (rank ≤ N).
 *
 * Trade-off: larger margin = calmer boundary, more visible hosts
 * during churn. 1 is the minimum that does anything; 0 would be
 * "strict top-N" (the pre-hysteresis behaviour, equivalent to
 * passing `margin: 0` to `projectAppend`).
 */
const TOP_N_HYSTERESIS_MARGIN = 1;

type ProjectionResult = {
  msg: AggregateAppendMsg;
  /**
   * The host set this projection shipped — feed back into the next
   * call's `prefs.lastTopHosts` to drive hysteresis. `null` when
   * there's no filter active (`topN: null`) or when the row set is
   * already short enough that hysteresis can't change the answer.
   */
  lastTopHosts: ReadonlySet<string> | null;
};

/**
 * Project an `aggregate-append` frame to a single client's view —
 * top-N rows by `prefs.rankBy` (a 1m baseline metric), descending,
 * with rank-based hysteresis so boundary jitter doesn't flicker the
 * cut at 5 Hz.
 *
 * Algorithm (per `friction-notes/M3.5.md`'s "Per-subscriber wire
 * projection — hysteresis" section):
 *
 *   keep = (strict top-N from sorted)
 *        ∪ (hosts in lastTopHosts whose new rank is in [N+1, N+margin])
 *
 * - **Strict top-N** is unconditional, so a new burst host vaulting
 *   from rank 20 to rank 1 is admitted on its first tick. No
 *   hysteresis on admission — only on expulsion.
 * - **Carry-over** lets a host that was just in the cut stay one
 *   tick longer if it's only one rank below the new cut. With margin
 *   1, the visible cut size is `N` in stable state and `N+1` during
 *   single-rank boundary churn (E ↔ F swap at the #N/#N+1 boundary).
 * - **Sustained drop** (rank > N+margin) expels the host even if it
 *   was in lastTopHosts — the cut isn't a one-way ratchet.
 *
 * `topN === null` (no filter) and `msg.rows.length ≤ topN` (everyone
 * fits) are no-op pass-throughs; the projected msg is the input msg
 * by reference. `lastTopHosts` is null on the no-filter path so a
 * later frame at a non-null topN starts fresh; on the everyone-fits
 * path it tracks the actual host set so the next-frame hysteresis
 * has a non-null reference if the row count grows past topN.
 */
function projectAppend(
  msg: AggregateAppendMsg,
  prefs: ClientPrefs,
  margin: number = TOP_N_HYSTERESIS_MARGIN,
): ProjectionResult {
  if (prefs.topN === null) return { msg, lastTopHosts: null };
  if (msg.rows.length <= prefs.topN) {
    // Everyone fits — pass-through, but record the host set so the
    // next call (which might genuinely need to cut) sees a populated
    // hysteresis reference.
    const hosts = new Set<string>();
    for (const r of msg.rows) hosts.add(r.host);
    return { msg, lastTopHosts: hosts };
  }
  // Descending by `rankBy`; nulls/undefineds last. The HostTick
  // schema declares the three RankKey columns as `number | null`
  // (rolling window may not be warm yet), so the value extractor
  // coerces null → -Infinity so cold-start hosts sort to the bottom
  // rather than spuriously landing at the top via NaN.
  const key = prefs.rankBy;
  const sorted = [...msg.rows].sort((a, b) => {
    const av = typeof a[key] === 'number' ? (a[key] as number) : -Infinity;
    const bv = typeof b[key] === 'number' ? (b[key] as number) : -Infinity;
    return bv - av;
  });
  // Strict top-N: always include (no hysteresis on admission).
  const keep = new Set<string>();
  const N = prefs.topN;
  for (let i = 0; i < N && i < sorted.length; i++) {
    keep.add(sorted[i].host);
  }
  // Carry-over: hosts in lastTopHosts at ranks (N, N+margin].
  // First-frame and post-`set-top-n` see lastTopHosts === null, so
  // this loop is a no-op and the projection collapses to strict
  // top-N. The cut warms up to its hysteresis-stable shape over
  // the first few frames.
  if (prefs.lastTopHosts && margin > 0) {
    const upper = Math.min(N + margin, sorted.length);
    for (let i = N; i < upper; i++) {
      const host = sorted[i].host;
      if (prefs.lastTopHosts.has(host)) keep.add(host);
    }
  }
  // Output rows in cpu_avg order (high first), filtered to `keep`.
  const rows: ReadonlyArray<HostTick> = sorted.filter((r) => keep.has(r.host));
  return { msg: { ...msg, rows }, lastTopHosts: keep };
}

/**
 * Parse + validate a client control message. Returns `null` on bad
 * input. Wire shape:
 *
 *   { type: 'set-top-n', n: number | null, by?: RankKey }
 *
 * `by` is optional for back-compat with clients that only send
 * `{ type, n }`; the parser leaves `rankBy` at the previous value
 * by returning `undefined` for the field (the caller merges with
 * existing prefs). An explicit invalid `by` value is rejected
 * (returns `null` for the whole message), not silently ignored —
 * so a client typo in the metric name surfaces rather than hides.
 */
function parseControlMessage(
  raw: unknown,
  hostCount: number,
):
  | { topN: number | null; rankBy: RankKey | undefined }
  | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { type?: unknown; n?: unknown; by?: unknown };
  if (obj.type !== 'set-top-n') return null;

  // `by` validation up front so a typo'd metric is rejected before
  // we accept the rest of the message. `undefined` (field omitted)
  // means "leave the existing rankBy unchanged"; explicit-invalid
  // (`'cpu_argh'` etc.) is a hard reject.
  let rankBy: RankKey | undefined;
  if (obj.by !== undefined) {
    if (typeof obj.by !== 'string') return null;
    if (!RANK_KEYS.includes(obj.by as RankKey)) return null;
    rankBy = obj.by as RankKey;
  }

  // `n: null` clears the filter (ship all rows).
  if (obj.n === null) return { topN: null, rankBy };
  if (typeof obj.n !== 'number' || !Number.isFinite(obj.n)) return null;
  // Clamp to a sane range. Lower bound 1 (zero hosts is a useless
  // chart); upper bound is the active host count or 1000 to allow
  // explicit "show all" without the client knowing the host count.
  const clamped = Math.max(
    1,
    Math.min(Math.floor(obj.n), Math.max(hostCount, 1000)),
  );
  return { topN: clamped, rankBy };
}

/**
 * Parse `?n=<int>&by=<RankKey>` query params from a WS handshake
 * URL. Returns the connect-time `ClientPrefs` shape. Missing or
 * invalid input falls back to the no-filter default — keeping the
 * pre-PR-#37 wire compatible with clients that don't send the
 * params yet.
 *
 * Why this exists: the dashboard sets its top-N via a `set-top-n`
 * control message after WS open, but the server has already sent
 * the entire snapshot-history backfill by then. Under firehose
 * load that backfill is the heaviest connection-time payload
 * (~12k rows × ~600 bytes), and shipping it unfiltered defeats
 * the per-subscriber projection. URL-time params let the server
 * apply the cut to the snapshot too — so a top-5 client never
 * receives history rows for the other 75 hosts. See PR #37
 * adversarial review for the full case.
 *
 * Defensive parsing — handles the same edge cases as
 * `parseControlMessage`:
 * - Non-finite `n` (`NaN`, `Infinity`) → null.
 * - Out-of-range `n` → clamped to `[1, 1000]` (the parser's
 *   conservative upper bound when host count isn't known yet).
 * - Unknown `by` → cpu_avg fallback (no hard reject — query
 *   strings come from URL bars and may be hand-edited; reject-
 *   on-typo at connect would be a worse UX than the
 *   control-channel one).
 */
function parseConnectQuery(rawUrl: string | undefined): {
  topN: number | null;
  rankBy: RankKey;
} {
  const fallback = { topN: null as number | null, rankBy: 'cpu_avg' as RankKey };
  if (!rawUrl) return fallback;
  const q = rawUrl.indexOf('?');
  if (q === -1) return fallback;
  const params = new URLSearchParams(rawUrl.slice(q + 1));
  let topN: number | null = null;
  const nStr = params.get('n');
  if (nStr !== null && nStr !== '') {
    const n = Number(nStr);
    if (Number.isFinite(n)) {
      topN = Math.max(1, Math.min(Math.floor(n), 1000));
    }
  }
  let rankBy: RankKey = 'cpu_avg';
  const byStr = params.get('by');
  if (byStr !== null && RANK_KEYS.includes(byStr as RankKey)) {
    rankBy = byStr as RankKey;
  }
  return { topN, rankBy };
}

/**
 * Project the snapshot-history rows through `projectAppend` per-
 * tick, threading hysteresis state across consecutive ticks. The
 * result is the same shape as the input (flat `HostTick[]` in
 * ts-ascending order) but trimmed to the client's `prefs.topN`
 * cut at every tick — the snapshot replay looks consistent with
 * the live frames that follow.
 *
 * Returns the final hysteresis state too so the caller can write
 * it back into the client's `ClientPrefs`; live frames continue
 * from where the snapshot left off rather than cold-starting.
 */
export function projectSnapshotHistory(
  rows: ReadonlyArray<HostTick>,
  prefs: ClientPrefs,
): { rows: HostTick[]; lastTopHosts: ReadonlySet<string> | null } {
  if (prefs.topN === null) {
    return { rows: [...rows], lastTopHosts: null };
  }
  // Group by ts. Rows from the snapshot ring are typically already
  // ordered ts-then-host (each emit-tick appends a contiguous run),
  // but the Map below is robust to any input order.
  const byTs = new Map<number, HostTick[]>();
  for (const r of rows) {
    let g = byTs.get(r.ts);
    if (!g) {
      g = [];
      byTs.set(r.ts, g);
    }
    g.push(r);
  }
  const sortedTs = [...byTs.keys()].sort((a, b) => a - b);
  const out: HostTick[] = [];
  let runningPrefs: ClientPrefs = prefs;
  for (const ts of sortedTs) {
    const tickRows = byTs.get(ts)!;
    const result = projectAppend(
      { type: 'aggregate-append', rows: tickRows },
      runningPrefs,
    );
    out.push(...result.msg.rows);
    runningPrefs = { ...runningPrefs, lastTopHosts: result.lastTopHosts };
  }
  return { rows: out, lastTopHosts: runningPrefs.lastTopHosts };
}

export { projectAppend, parseControlMessage, parseConnectQuery };

export type ServerOptions = {
  port: number;
  host?: string;
  live: LiveSeries<Schema>;
  /** Override the M3.5 aggregate-stream tick cadence. */
  aggregateTickMs?: number;
};

export type RunningServer = {
  stop: () => Promise<void>;
};

/**
 * Start the HTTP+WS server. Two WebSocket endpoints today:
 *
 * - `/live` — the existing raw-event firehose. Snapshot on connect
 *   (current `live.toJSON()`), then one `append` frame per
 *   `LiveSeries.on('batch', …)` callback. Source of truth for the
 *   dashboard until the M3.5 aggregate stream feature-completes.
 * - `/live-agg` — the M3.5 aggregate stream. Snapshot on connect
 *   (forward-compatible envelope, currently empty rows), then one
 *   `aggregate-append` frame per 200ms tick carrying per-host
 *   rolling 1m mean/sd/count over CPU.
 *
 * Two endpoints in parallel so the dashboard can migrate
 * incrementally; `/live` will go away once `/live-agg` reaches
 * feature parity per `WIRE.md`.
 *
 * v1 has no slow-client policy and no snapshot caching (M4). Sends
 * skip closed sockets but make no per-client buffer-pressure check.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const fastify = Fastify({ logger: { level: 'info' } });

  fastify.get('/health', async () => ({ ok: true }));

  fastify.get('/metrics', async () => {
    const bufferedAmount: number[] = [];
    for (const c of clients) bufferedAmount.push(c.bufferedAmount);
    for (const c of aggClients.keys()) bufferedAmount.push(c.bufferedAmount);
    return metricsSnapshot({
      liveSeriesLength: opts.live.length,
      wsClientBufferedAmounts: bufferedAmount,
    });
  });

  await fastify.listen({ port: opts.port, host: opts.host ?? '0.0.0.0' });

  const wss = new WebSocketServer({
    server: fastify.server,
    // Reject anything that isn't one of our paths so a stray /foo
    // doesn't open a half-handled socket. The verify callback's
    // second arg is the HTTP status returned during handshake (NOT a
    // WebSocket close code), so 404 — there's no path here.
    verifyClient: (info, cb) => {
      const path = pathnameOf(info.req.url);
      const ok = path === '/live' || path === '/live-agg';
      cb(ok, ok ? undefined : 404, ok ? undefined : 'unknown path');
    },
  });
  const clients = new Set<WebSocket>();
  // `Map` (not `Set`) so each `/live-agg` client carries its own
  // top-N preference — see `ClientPrefs` doc above. Default
  // `{ topN: null }` (= no filter) on connect for backward compat;
  // dashboard updates via `{type:'set-top-n', n}` control messages.
  const aggClients = new Map<WebSocket, ClientPrefs>();

  // Start the aggregator first — its `getSnapshotHistory` getter
  // closes over the running history ring and we want the WS
  // connection handler to use it. Order doesn't strictly matter
  // (fastify doesn't accept connections until `listen` runs below),
  // but keeping it explicit avoids any "accept before bind"
  // confusion if this code grows.
  const stopFanout = startFanout(opts.live, (frame) => {
    let openCount = 0;
    for (const c of clients) {
      if (c.readyState === c.OPEN) {
        c.send(frame);
        openCount += 1;
      }
    }
    // Total bytes pushed onto the wire across all clients for this
    // frame — used by /metrics for aggregate egress accounting.
    if (openCount > 0) recordBytesSent(frame.length * openCount);
  });

  const { stop: stopAggregate, getSnapshotHistory } = startAggregate(
    opts.live,
    (msg) => {
      // Per-subscriber wire projection: each client gets its own
      // top-N filtered view. `projectAppend` is a no-op pass-through
      // when `prefs.topN === null`. Encode once per client because
      // payloads diverge — the previous all-clients-share-one-frame
      // optimisation no longer applies. At C clients × N hosts the
      // per-tick cost is O(C × N log N), trivial at any scale this
      // experiment runs at.
      //
      // Hysteresis: `projectAppend` returns the projected msg AND
      // the host set it shipped. We write that set back into the
      // client's prefs entry so the next call has hysteresis state
      // to read. Mutating the entry rather than `aggClients.set(...)`
      // because `prefs` is the live object (Maps return references)
      // — saves per-tick Map churn at C clients.
      let totalBytes = 0;
      for (const [ws, prefs] of aggClients) {
        if (ws.readyState !== ws.OPEN) continue;
        const result = projectAppend(msg, prefs);
        const frame = encode(result.msg);
        ws.send(frame);
        totalBytes += frame.length;
        prefs.lastTopHosts = result.lastTopHosts;
      }
      if (totalBytes > 0) recordBytesSent(totalBytes);
    },
    { tickMs: opts.aggregateTickMs },
  );

  wss.on('connection', (socket, req) => {
    // Tolerate `?foo=1` in case a client appends query params later
    // for cache busting / debug. Path is the dispatch key.
    if (pathnameOf(req.url) === '/live-agg') {
      // Initial prefs from the WS handshake URL's `?n=&by=` query
      // params. The dashboard ships these as connect-time hints so
      // the server applies the per-subscriber projection to the
      // snapshot backfill below — without that, every connect /
      // reconnect ships the entire 5-min history unfiltered (~12k
      // rows × ~600 bytes) and re-introduces the connect-time
      // payload spike the projection was meant to avoid (PR #37
      // adversarial review).
      //
      // Missing / invalid params → `topN: null`, `rankBy: cpu_avg`
      // (the pre-PR-#37 wire shape, fully back-compat with older
      // clients that don't know about the URL hints).
      const initialPrefs: ClientPrefs = {
        ...parseConnectQuery(req.url),
        lastTopHosts: null,
      };
      aggClients.set(socket, initialPrefs);
      // Step 8 — snapshot history. The aggregator maintains a ~5m
      // ring of recent `HostTick`s + `GlobalsTick`s; on connect we
      // ship that tail so the dashboard renders the full back-window
      // immediately rather than filling in over time. Empty arrays
      // for the very first client (aggregator just started, no
      // history yet); steady-state ships ~12k rows + ~1.5k globals.
      //
      // Project through the same `projectAppend` rules the live
      // frames use — same top-N cut, same hysteresis (warmed up
      // across the snapshot's own ticks). The dashboard sees a
      // snapshot that's consistent with the live frames that
      // follow rather than a wide history followed by a sudden
      // narrow live cut.
      const history = getSnapshotHistory();
      const projected = projectSnapshotHistory(history.rows, initialPrefs);
      // Continue hysteresis from where the snapshot left off so
      // the first live frame doesn't cold-start. The first live
      // tick will see this state and decide carry-overs against
      // the snapshot's tail rather than against an empty set.
      aggClients.set(socket, {
        ...initialPrefs,
        lastTopHosts: projected.lastTopHosts,
      });
      const snap: AggregateSnapshotMsg = {
        type: 'aggregate-snapshot',
        thresholds: DEFAULT_AGGREGATE_THRESHOLDS,
        rows: projected.rows,
        globals: history.globals,
      };
      socket.send(encode(snap));
      // Control channel — accept `{type:'set-top-n', n}` messages
      // to update this client's filter. `parseControlMessage`
      // validates + clamps; ill-formed input is silently dropped
      // (defensive against random garbage from a misbehaving
      // client without disconnecting them). `hostCount` for the
      // clamp comes from the snapshot's row distinctness — close
      // enough at steady state, and the absolute upper bound in
      // the parser is generous (1000) so a connecting client that
      // doesn't yet know the host count can still send sane
      // values.
      socket.on('message', (data) => {
        const text =
          typeof data === 'string'
            ? data
            : data instanceof Buffer
              ? data.toString('utf-8')
              : '';
        const result = parseControlMessage(text, history.rows.length);
        if (result === null) return;
        const prev = aggClients.get(socket);
        if (!prev) return; // socket already removed
        // Reset hysteresis state on any prefs change — the old
        // `lastTopHosts` was sized for the previous N + metric and
        // would carry stale entries through the new projection's
        // first few frames. Letting the new cut warm up from null
        // is cleaner than mapping carry entries across configs.
        // `rankBy` defaults to the previous value when the message
        // didn't include `by` (parser returns `undefined`).
        aggClients.set(socket, {
          ...prev,
          topN: result.topN,
          rankBy: result.rankBy ?? prev.rankBy,
          lastTopHosts: null,
        });
      });
      socket.on('close', () => aggClients.delete(socket));
      socket.on('error', () => aggClients.delete(socket));
      return;
    }
    // Default `/live` — verifyClient already rejected anything else.
    clients.add(socket);
    socket.send(encode(buildSnapshot(opts.live)));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  return {
    stop: async () => {
      stopFanout();
      stopAggregate();
      for (const c of clients) c.close();
      for (const c of aggClients.keys()) c.close();
      wss.close();
      await fastify.close();
    },
  };
}

/**
 * Extract the pathname of a request URL. WS handshake `req.url` is
 * just the path-and-query (`/foo?bar=1`), not a full URL — split on
 * `?` rather than constructing a `URL` (cheap, no allocation).
 */
function pathnameOf(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
