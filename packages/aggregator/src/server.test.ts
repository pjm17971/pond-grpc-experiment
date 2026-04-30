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
import { recordIngest, type MetricsSnapshot } from './metrics.js';

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
