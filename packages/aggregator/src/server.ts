import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { type LiveSeries } from 'pond-ts';
import {
  type AggregateSnapshotMsg,
  type Schema,
  DEFAULT_AGGREGATE_THRESHOLDS,
  encode,
} from '@pond-experiment/shared';
import { buildSnapshot } from './snapshot.js';
import { startFanout } from './fanout.js';
import { startAggregate } from './aggregate.js';
import { recordBytesSent, snapshot as metricsSnapshot } from './metrics.js';

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
    for (const c of aggClients) bufferedAmount.push(c.bufferedAmount);
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
  const aggClients = new Set<WebSocket>();

  wss.on('connection', (socket, req) => {
    // Tolerate `?foo=1` in case a client appends query params later
    // for cache busting / debug. Path is the dispatch key.
    if (pathnameOf(req.url) === '/live-agg') {
      aggClients.add(socket);
      const snap: AggregateSnapshotMsg = {
        type: 'aggregate-snapshot',
        thresholds: DEFAULT_AGGREGATE_THRESHOLDS,
        rows: [],
      };
      socket.send(encode(snap));
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

  const { stop: stopAggregate } = startAggregate(
    opts.live,
    (frame) => {
      let openCount = 0;
      for (const c of aggClients) {
        if (c.readyState === c.OPEN) {
          c.send(frame);
          openCount += 1;
        }
      }
      if (openCount > 0) recordBytesSent(frame.length * openCount);
    },
    { tickMs: opts.aggregateTickMs },
  );

  return {
    stop: async () => {
      stopFanout();
      stopAggregate();
      for (const c of clients) c.close();
      for (const c of aggClients) c.close();
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
