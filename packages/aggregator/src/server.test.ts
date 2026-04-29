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
} from '@pond-experiment/shared';
import { startServer, type RunningServer } from './server.js';

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
