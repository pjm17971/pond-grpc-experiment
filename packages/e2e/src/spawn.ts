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
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      checkBuffer('stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
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
};

export async function spawnAggregator(
  opts: AggregatorOptions,
): Promise<SpawnedProcess> {
  const env: Record<string, string> = {
    AGGREGATOR_PORT: String(opts.httpPort),
    PRODUCER_URL: opts.producerUrl,
  };
  const { child, pid } = await spawnReady({
    cwd: resolvePath(repoRoot, 'packages/aggregator'),
    env,
    readyMatch: /aggregator listening on/,
  });
  return { pid, stop: stopper(child) };
}
