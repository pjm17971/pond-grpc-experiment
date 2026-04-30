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
    // Reject anything that isn't one of our paths so noVerifyClient
    // doesn't grant /foo a connection. ws emits 'wsClientError' on
    // mismatch; the default behaviour is to close the socket cleanly.
    verifyClient: (info, cb) => {
      const url = info.req.url ?? '';
      const ok = url === '/live' || url === '/live-agg';
      cb(ok, ok ? undefined : 1008, ok ? undefined : 'unknown path');
    },
  });
  const clients = new Set<WebSocket>();
  const aggClients = new Set<WebSocket>();

  wss.on('connection', (socket, req) => {
    if (req.url === '/live-agg') {
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
    // Default `/live` (also reached on the legacy unprefixed connect).
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
