import { afterEach, describe, expect, it } from 'vitest';
import {
  allocatePort,
  spawnAggregator,
  spawnProducer,
  type SpawnedProcess,
} from './spawn.js';
import { connectProbe, type Probe } from './probe.js';

/**
 * End-to-end tests for the three-process flow. Each test spawns
 * `producer` and `aggregator` child processes, opens a `Probe`
 * WebSocket against the aggregator, and asserts the snapshot+append
 * protocol behaviour under the kill-9 / restart paths PLAN.md M2
 * names as exit criteria.
 *
 * These are intentionally slow (process spawn + ~1s wait per
 * scenario) — gated under `pnpm test:e2e` rather than the default
 * `pnpm test`. CI runs them on a separate job.
 */
describe('three-process E2E', () => {
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;
  let probe: Probe | undefined;

  afterEach(async () => {
    probe?.close();
    await aggregator?.stop('SIGTERM');
    await producer?.stop('SIGTERM');
    probe = undefined;
    aggregator = undefined;
    producer = undefined;
  });

  it('happy path: events flow producer → aggregator → probe', async () => {
    const grpcPort = await allocatePort();
    const httpPort = await allocatePort();

    producer = await spawnProducer({ grpcPort, eventsPerSec: 16 });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
    });
    probe = await connectProbe(`ws://127.0.0.1:${httpPort}/live`);

    // Snapshot is the first frame the server sends.
    await probe.waitFor(
      (frames) => frames.length >= 1 && frames[0].type === 'snapshot',
      3000,
      'snapshot',
    );

    // Append frames follow as the simulator ticks.
    await probe.waitFor(
      (frames) =>
        frames.filter((f) => f.type === 'append').length >= 2,
      5000,
      'append',
    );

    expect(probe.frames[0].type).toBe('snapshot');
    expect(
      probe.frames.filter((f) => f.type === 'append').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('kill -9 producer → aggregator reconnects, probe sees gap then resume', async () => {
    const grpcPort = await allocatePort();
    const httpPort = await allocatePort();

    producer = await spawnProducer({ grpcPort, eventsPerSec: 16 });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
    });
    probe = await connectProbe(`ws://127.0.0.1:${httpPort}/live`);

    // Wait for first append to confirm the chain is live.
    await probe.waitFor(
      (frames) => frames.filter((f) => f.type === 'append').length >= 2,
      5000,
      'pre-kill append',
    );
    const appendsBeforeKill = probe.frames.filter(
      (f) => f.type === 'append',
    ).length;

    // Kill -9 the producer. The aggregator's gRPC client should
    // start its backoff loop; the WS to the probe stays up.
    await producer.stop('SIGKILL');
    producer = undefined;

    // Note the count, then wait briefly so any pending in-flight
    // appends arrive before the gap, then assert no growth.
    await sleep(500);
    const afterKillCount = probe.frames.filter(
      (f) => f.type === 'append',
    ).length;
    await sleep(1500);
    const noGrowthCount = probe.frames.filter(
      (f) => f.type === 'append',
    ).length;
    expect(noGrowthCount).toBe(afterKillCount);

    // Restart the producer on the SAME port so the aggregator's
    // already-scheduled reconnect lands on a fresh stream.
    producer = await spawnProducer({ grpcPort, eventsPerSec: 16 });

    // Subsequent appends pick up. The shared backoff caps at 30s
    // with ±20% jitter, so the absolute worst-case retry interval is
    // ~36s; use a 40s timeout to absorb that even if the test
    // happens to hit the cap.
    await probe.waitFor(
      (frames) =>
        frames.filter((f) => f.type === 'append').length >
        noGrowthCount + 1,
      40_000,
      'post-restart append',
    );
    expect(
      probe.frames.filter((f) => f.type === 'append').length,
    ).toBeGreaterThan(appendsBeforeKill);
  }, 60_000);

  it('kill -9 aggregator → probe sees close, reconnects to a fresh snapshot on restart', async () => {
    const grpcPort = await allocatePort();
    const httpPort = await allocatePort();

    producer = await spawnProducer({ grpcPort, eventsPerSec: 16 });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
    });
    probe = await connectProbe(`ws://127.0.0.1:${httpPort}/live`);

    await probe.waitFor(
      (frames) => frames.filter((f) => f.type === 'append').length >= 2,
      5000,
      'pre-kill append',
    );

    // Kill -9 the aggregator. The probe's WS receives a close;
    // unlike `useRemoteLiveSeries` the probe doesn't auto-reconnect
    // — that's the hook's job. We instead spin up a second probe
    // against the restarted aggregator below.
    await aggregator.stop('SIGKILL');
    aggregator = undefined;

    await waitFor(() => probe!.isClosed(), 3000, 'probe close');
    expect(probe.isClosed()).toBe(true);

    // Restart the aggregator on the same port and connect a fresh
    // probe; it should receive a snapshot frame first, then append
    // frames as the aggregator's gRPC ingest keeps pulling from
    // the still-running producer.
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
    });
    const probe2 = await connectProbe(`ws://127.0.0.1:${httpPort}/live`);
    try {
      await probe2.waitFor(
        (frames) => frames.length >= 1 && frames[0].type === 'snapshot',
        3000,
        'fresh snapshot',
      );
      expect(probe2.frames[0].type).toBe('snapshot');

      // Appends follow as the aggregator forwards events from the
      // (still-up) producer. Asserts the full flow recovered, not
      // just the initial handshake.
      await probe2.waitFor(
        (frames) =>
          frames.filter((f) => f.type === 'append').length >= 1,
        5000,
        'fresh append',
      );
      expect(
        probe2.frames.filter((f) => f.type === 'append').length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      probe2.close();
    }
  }, 30_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  label?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline)
        reject(
          new Error(
            `waitFor${label ? ` (${label})` : ''} timed out after ${timeoutMs}ms`,
          ),
        );
      else setTimeout(tick, 25);
    };
    tick();
  });
}
