import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(here, '..', '..', '..');

export type SpawnedProcess = {
  /** The pid of the spawned process. */
  pid: number;
  /** Stop with `SIGTERM` (graceful) or `SIGKILL` (kill -9 simulation). */
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

/**
 * Allocate a free TCP port by listening on `0` and reading the OS-
 * assigned port back. Used to keep parallel test runs from
 * colliding on fixed defaults (gRPC 50051, HTTP 8080).
 */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('unexpected server.address()'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  /** stdout/stderr line that signals readiness. */
  readyMatch: RegExp;
};

const READY_TIMEOUT_MS = 15_000;

async function spawnReady(opts: SpawnOptions): Promise<{
  child: ChildProcess;
  pid: number;
}> {
  // Resolve `tsx` from the package's node_modules/.bin. pnpm always
  // materialises a binary symlink there for each package's devDeps.
  const tsx = resolvePath(opts.cwd, 'node_modules/.bin/tsx');

  const child = spawn(tsx, ['src/index.ts'], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: 'pipe',
    // Detached + new process group so SIGKILL on the group reaches
    // any future grandchildren cleanly. Not strictly needed today
    // (we spawn tsx directly, no shell wrapper), but cheap insurance.
    detached: true,
  });

  if (!child.pid) {
    throw new Error('spawn returned no pid');
  }

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(
        new Error(
          `process did not match ready pattern within ${READY_TIMEOUT_MS}ms`,
        ),
      );
    }, READY_TIMEOUT_MS);

    // Accumulate per-stream buffers so the ready regex sees full
    // log lines even when stdio writes split across chunks.
    let stdoutBuf = '';
    let stderrBuf = '';
    const checkBuffer = (which: 'stdout' | 'stderr') => {
      const buf = which === 'stdout' ? stdoutBuf : stderrBuf;
      if (opts.readyMatch.test(buf)) {
        clearTimeout(timeout);
        resolveReady();
      }
    };
    // When SPAWN_VERBOSE=1, mirror child stdio to the parent's so
     // diagnostic logs (e.g. the aggregator's `LATE_DEBUG=1` warns)
     // are visible during harness runs. Off by default — bench /
     // drift scripts produce their own structured reports and the
     // child noise would clutter them.
    const verbose = process.env.SPAWN_VERBOSE === '1';
    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stdoutBuf += s;
      if (verbose) process.stdout.write(`[child:${child.pid}] ${s}`);
      checkBuffer('stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stderrBuf += s;
      if (verbose) process.stderr.write(`[child:${child.pid}] ${s}`);
      checkBuffer('stderr');
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(`process exited (code ${code}) before reaching ready state`),
      );
    });
  });

  await ready;
  return { child, pid: child.pid };
}

function stopper(child: ChildProcess): SpawnedProcess['stop'] {
  return async (signal = 'SIGTERM') => {
    if (child.exitCode != null) return;
    if (!child.pid) return;
    try {
      // Negative pid kills the whole process group.
      process.kill(-child.pid, signal);
    } catch {
      // Group kill failed (e.g. process already gone); fall back to
      // direct kill which no-ops on a dead pid.
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
    if (child.exitCode == null) {
      await new Promise<void>((res) => child.once('exit', () => res()));
    }
  };
}

export type ProducerOptions = {
  grpcPort: number;
  eventsPerSec?: number;
  hostCount?: number;
  variability?: number;
  /**
   * Late-event injection knobs — drives the milestone-B late-data
   * driver. Default is a no-op (`fraction=0`); the drift-comparison
   * harness flips `fraction` to a non-zero value for the
   * "late-loaded" leg of an A/B run. See
   * `packages/producer/src/lateInjector.ts` for the math.
   */
  lateEventFraction?: number;
  lateEventDelayMs?: number;
  lateEventDelayTailMs?: number;
  /** `host:fraction,host:fraction` env-string format. */
  lateEventHostBias?: string;
  lateEventSeed?: number;
  /** Producer's HTTP /metrics port (only listens when injection is on). */
  metricsPort?: number;
};

export async function spawnProducer(
  opts: ProducerOptions,
): Promise<SpawnedProcess> {
  const env: Record<string, string> = {
    GRPC_PORT: String(opts.grpcPort),
    EVENTS_PER_SEC: String(opts.eventsPerSec ?? 8),
    HOST_COUNT: String(opts.hostCount ?? 4),
    VARIABILITY: String(opts.variability ?? 0.4),
  };
  if (opts.lateEventFraction !== undefined) {
    env.LATE_EVENT_FRACTION = String(opts.lateEventFraction);
  }
  if (opts.lateEventDelayMs !== undefined) {
    env.LATE_EVENT_DELAY_MS = String(opts.lateEventDelayMs);
  }
  if (opts.lateEventDelayTailMs !== undefined) {
    env.LATE_EVENT_DELAY_TAIL_MS = String(opts.lateEventDelayTailMs);
  }
  if (opts.lateEventHostBias !== undefined) {
    env.LATE_EVENT_HOST_BIAS = opts.lateEventHostBias;
  }
  if (opts.lateEventSeed !== undefined) {
    env.LATE_EVENT_SEED = String(opts.lateEventSeed);
  }
  if (opts.metricsPort !== undefined) {
    env.METRICS_PORT = String(opts.metricsPort);
  }
  const { child, pid } = await spawnReady({
    cwd: resolvePath(repoRoot, 'packages/producer'),
    env,
    readyMatch: /producer listening on/,
  });
  return { pid, stop: stopper(child) };
}

export type AggregatorOptions = {
  httpPort: number;
  producerUrl: string;
  /**
   * Pond `LiveSeries` ordering mode. Drives milestone-B's late-data
   * driver: `'reorder'` accepts late events within `graceWindow`,
   * `'drop'` silently rejects them, `'strict'` (default) throws on
   * any out-of-order arrival.
   */
  ordering?: 'strict' | 'reorder' | 'drop';
  /** Grace window for `'reorder'` mode (ms). Defaults to 30000 (= retention). */
  graceWindowMs?: number;
  /** Per-host stride sample factor (passed via env). */
  sampleStride?: number;
};

export async function spawnAggregator(
  opts: AggregatorOptions,
): Promise<SpawnedProcess> {
  const env: Record<string, string> = {
    AGGREGATOR_PORT: String(opts.httpPort),
    PRODUCER_URL: opts.producerUrl,
  };
  if (opts.ordering !== undefined) {
    env.ORDERING = opts.ordering;
  }
  if (opts.graceWindowMs !== undefined) {
    env.GRACE_WINDOW_MS = String(opts.graceWindowMs);
  }
  if (opts.sampleStride !== undefined) {
    env.SAMPLE_STRIDE = String(opts.sampleStride);
  }
  const { child, pid } = await spawnReady({
    cwd: resolvePath(repoRoot, 'packages/aggregator'),
    env,
    readyMatch: /aggregator listening on/,
  });
  return { pid, stop: stopper(child) };
}
