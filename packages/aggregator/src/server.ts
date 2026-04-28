import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { type LiveSeries } from 'pond-ts';
import { encode, type Schema } from '@pond-experiment/shared';
import { buildSnapshot } from './snapshot.js';
import { startFanout } from './fanout.js';

export type ServerOptions = {
  port: number;
  host?: string;
  live: LiveSeries<Schema>;
};

export type RunningServer = {
  fastify: FastifyInstance;
  wss: WebSocketServer;
  /** Open WS clients. Exposed for tests. */
  clients: Set<WebSocket>;
  stop: () => Promise<void>;
};

/**
 * Start the HTTP+WS server. `/health` returns liveness; `/live` is
 * the WebSocket endpoint that emits a snapshot frame on connect and
 * subsequent append frames per `LiveSeries.on('batch', …)`.
 *
 * v1 has no slow-client policy and no snapshot caching (M4). Sends
 * skip closed sockets but make no per-client buffer-pressure check.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const fastify = Fastify({ logger: { level: 'info' } });

  fastify.get('/health', async () => ({ ok: true }));

  await fastify.listen({ port: opts.port, host: opts.host ?? '0.0.0.0' });

  const wss = new WebSocketServer({ server: fastify.server, path: '/live' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(encode(buildSnapshot(opts.live)));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  const stopFanout = startFanout(opts.live, (frame) => {
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(frame);
    }
  });

  return {
    fastify,
    wss,
    clients,
    stop: async () => {
      stopFanout();
      for (const c of clients) c.close();
      wss.close();
      await fastify.close();
    },
  };
}
