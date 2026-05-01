/**
 * Profile the aggregator at the high-load regime to understand the
 * V1 (manual HostAggregator) vs V3 (pond rolling) throughput gap.
 *
 * Spawns producer + aggregator-with-cpu-prof + a probe to /live-agg,
 * runs for `seconds`, then stops cleanly. The aggregator child writes
 * its cpu profile on exit.
 *
 * Usage:
 *   pnpm exec tsx scripts/profile-agg.ts --P=1000 --N=1000 --seconds=20
 */
import { mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocatePort,
  spawnProducer,
  type SpawnedProcess,
} from '@pond-experiment/dev-utils';
import WebSocket from 'ws';

type Args = { P: number; N: number; seconds: number; profDir: string };

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (k: string): string | undefined => {
    const prefix = `--${k}=`;
    return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };
  return {
    P: Number(get('P') ?? '1000'),
    N: Number(get('N') ?? '1000'),
    seconds: Number(get('seconds') ?? '20'),
    profDir: get('profDir') ?? '/tmp/agg-prof',
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const aggregatorPkg = resolvePath(here, '..');

async function spawnAggregatorProfiled(opts: {
  httpPort: number;
  producerUrl: string;
  profDir: string;
}): Promise<{ stop: () => Promise<void>; child: ChildProcess }> {
  // Run tsx directly so we own the node process being profiled (not
  // a pnpm wrapper, not the dev-utils helper which goes through tsx).
  const tsx = resolvePath(aggregatorPkg, 'node_modules/.bin/tsx');
  const env = {
    ...process.env,
    AGGREGATOR_PORT: String(opts.httpPort),
    PRODUCER_URL: opts.producerUrl,
    // Drop --cpu-prof-name so each child of tsx writes to a distinct
    // pid-stamped file (otherwise they clobber). The largest one
    // post-run is the actual aggregator.
    NODE_OPTIONS:
      `--cpu-prof --cpu-prof-dir=${opts.profDir} --cpu-prof-interval=500`,
  };
  const child = spawn(tsx, ['src/index.ts'], {
    cwd: aggregatorPkg,
    env,
    stdio: 'pipe',
    detached: true,
  });
  if (!child.pid) throw new Error('aggregator spawn returned no pid');

  // Wait for the readiness line.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('aggregator did not become ready in 15s')),
      15_000,
    );
    let buf = '';
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString();
      if (/aggregator listening on/.test(buf)) {
        clearTimeout(timeout);
        child.stdout?.off('data', onChunk);
        child.stderr?.off('data', onChunk);
        resolve();
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`aggregator exited early with code ${code}`));
    });
  });

  return {
    child,
    stop: async () => {
      // Send SIGINT (clean shutdown — index.ts handles it and exits
      // gracefully so the cpu-prof write completes).
      if (child.exitCode === null) {
        child.kill('SIGINT');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5_000);
          child.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `profile-agg: P=${args.P}, N=${args.N}, ${args.seconds}s, profDir=${args.profDir}`,
  );
  mkdirSync(args.profDir, { recursive: true });

  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: { stop: () => Promise<void>; child: ChildProcess } | undefined;
  let probe: WebSocket | undefined;

  try {
    producer = await spawnProducer({
      grpcPort,
      eventsPerSec: args.N,
      hostCount: args.P,
    });
    aggregator = await spawnAggregatorProfiled({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
      profDir: args.profDir,
    });
    probe = new WebSocket(`ws://127.0.0.1:${httpPort}/live-agg`);
    await new Promise<void>((res, rej) => {
      probe!.on('open', () => res());
      probe!.on('error', rej);
    });

    console.log(`aggregator pid=${aggregator.child.pid}, profiling…`);
    // No warmup overhead — we want the cpu profile to capture the full
    // ramp + steady-state. The profile post-processing can ignore
    // early samples if needed.
    await new Promise((res) => setTimeout(res, args.seconds * 1000));
  } finally {
    probe?.close();
    if (aggregator) await aggregator.stop();
    if (producer) await producer.stop('SIGTERM');
  }

  console.log(
    `done. profile written to ${args.profDir}/aggregator.cpuprofile (and per-thread variants).`,
  );
}

await main();
