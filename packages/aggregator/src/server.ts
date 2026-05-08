import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { type LiveSeries } from 'pond-ts';
import {
  type AggregateAppendMsg,
  type AggregateSnapshotMsg,
  type HostTick,
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
 * Friction note candidate: pond's `live.on('batch', cb)` fires the
 * same payload to every listener; "per-subscriber projection" is a
 * wire-design pattern several streaming-server projects will
 * reinvent if there's no library scaffolding for it.
 */
type ClientPrefs = {
  /** `null` = no filter (ship all rows). Numeric = top-N by 1m baseline cpu_avg. */
  topN: number | null;
};

/**
 * Project an `aggregate-append` frame to a single client's view —
 * top-N rows by `cpu_avg`, descending. Hosts with null `cpu_avg`
 * (rolling baseline empty) sort to the bottom. `topN === null` is
 * a no-op pass-through.
 *
 * Stable enough for the dashboard at typical scales (≤80 hosts);
 * real production streams would want hysteresis (keep a host that's
 * been in the cut unless it drops below #topN by a margin) to stop
 * boundary flicker. Adding hysteresis is a per-client state change
 * — this module's `ClientPrefs` would gain a `lastTopHosts: Set`.
 * Punted to a follow-up refinement.
 */
function projectAppend(
  msg: AggregateAppendMsg,
  prefs: ClientPrefs,
): AggregateAppendMsg {
  if (prefs.topN === null || msg.rows.length <= prefs.topN) return msg;
  // Descending by cpu_avg; nulls/undefineds last.
  const sorted = [...msg.rows].sort((a, b) => {
    const av = typeof a.cpu_avg === 'number' ? a.cpu_avg : -Infinity;
    const bv = typeof b.cpu_avg === 'number' ? b.cpu_avg : -Infinity;
    return bv - av;
  });
  const rows: ReadonlyArray<HostTick> = sorted.slice(0, prefs.topN);
  return { ...msg, rows };
}

/** Parse + validate a client control message. Returns null on bad input. */
function parseControlMessage(
  raw: unknown,
  hostCount: number,
): { topN: number | null } | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { type?: unknown; n?: unknown };
  if (obj.type !== 'set-top-n') return null;
  // `n: null` clears the filter (ship all rows).
  if (obj.n === null) return { topN: null };
  if (typeof obj.n !== 'number' || !Number.isFinite(obj.n)) return null;
  // Clamp to a sane range. Lower bound 1 (zero hosts is a useless
  // chart); upper bound is the active host count or 1000 to allow
  // explicit "show all" without the client knowing the host count.
  const clamped = Math.max(
    1,
    Math.min(Math.floor(obj.n), Math.max(hostCount, 1000)),
  );
  return { topN: clamped };
}

export { projectAppend, parseControlMessage };

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
      let totalBytes = 0;
      for (const [ws, prefs] of aggClients) {
        if (ws.readyState !== ws.OPEN) continue;
        const projected = projectAppend(msg, prefs);
        const frame = encode(projected);
        ws.send(frame);
        totalBytes += frame.length;
      }
      if (totalBytes > 0) recordBytesSent(totalBytes);
    },
    { tickMs: opts.aggregateTickMs },
  );

  wss.on('connection', (socket, req) => {
    // Tolerate `?foo=1` in case a client appends query params later
    // for cache busting / debug. Path is the dispatch key.
    if (pathnameOf(req.url) === '/live-agg') {
      // Initial prefs: no filter (ship everything). Dashboard
      // immediately follows up with a `{type:'set-top-n', n: 5}`
      // control message after WS open; until that lands, the first
      // few append frames carry all hosts. Snapshot frame on
      // connect ships the full history regardless of `topN` —
      // history backfill is a one-shot, not steady-state load.
      aggClients.set(socket, { topN: null });
      // Step 8 — snapshot history. The aggregator maintains a ~5m
      // ring of recent `HostTick`s + `GlobalsTick`s; on connect we
      // ship that tail so the dashboard renders the full back-window
      // immediately rather than filling in over time. Empty arrays
      // for the very first client (aggregator just started, no
      // history yet); steady-state ships ~12k rows + ~1.5k globals.
      const history = getSnapshotHistory();
      const snap: AggregateSnapshotMsg = {
        type: 'aggregate-snapshot',
        thresholds: DEFAULT_AGGREGATE_THRESHOLDS,
        rows: history.rows,
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
        aggClients.set(socket, { ...prev, topN: result.topN });
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
