/**
 * Heap-snapshot profiler for the column-native-live-pipeline brief.
 *
 * Reproduces the documented OOM cell (firehose × 90s retention,
 * the historical step-7-follow-up shape per `aggregator/src/index.ts`
 * line 42) and writes a V8 heap snapshot at the moment the source
 * `LiveSeries` deque is deeply populated but before V8 has hit its
 * heap ceiling. Output: `/tmp/aggregator-<ts>.heapsnapshot` plus a
 * companion `.summary.json` with `live.length` + `pond.stats()` at
 * snapshot time.
 *
 * The aggregator is spawned with `HEAP_DUMP_AT_SEC=75` which schedules
 * `v8.writeHeapSnapshot()` at +75s — long enough for the deque to
 * hold ~5.25M events at ~70k/s (the rate the experiment's `bench:agg`
 * sustains, per BENCH.md), well within V8's default 4GB ceiling
 * still has snapshot-write room (~1GB allocations during snapshot
 * serialisation).
 *
 *   pnpm exec tsx scripts/heap-profile-oom-cell.ts
 *
 * After the run, analyse with:
 *   pnpm exec tsx scripts/analyse-heap-snapshot.ts /tmp/aggregator-*.heapsnapshot
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocatePort,
  spawnAggregator,
  spawnProducer,
  type SpawnedProcess,
} from '@pond-experiment/dev-utils';

type Args = {
  hosts: number;
  eventsPerSec: number;
  dumpAtSec: number;
  totalDurationSec: number;
  retention: string;
  outDir: string;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (k: string): string | undefined => {
    const prefix = `--${k}=`;
    return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };
  return {
    // 100 hosts × 700/s/host = 70k/s — matches the demo I just ran
    // and the 70k drift-harness shape, sustainable on the test
    // machine's gRPC wire.
    hosts: Number(get('hosts') ?? '100'),
    eventsPerSec: Number(get('eps') ?? '700'),
    // Snapshot at 75s: deque is fully populated (90s retention × 70k/s
    // = 6.3M events theoretical, but conservation drift at firehose
    // means actual ~3-4M events make it through, well past V8's
    // shift-fallback threshold).
    dumpAtSec: Number(get('dump-at-sec') ?? '75'),
    // Stop at 80s — snapshot write takes ~3-5s, give the process
    // time to write before SIGTERM.
    totalDurationSec: Number(get('total-sec') ?? '85'),
    // 90s = the historical step-7-follow-up retention that OOM'd at
    // firehose, per the index.ts comment block.
    retention: get('retention') ?? '90s',
    outDir: get('out-dir') ?? '/tmp',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `heap-profile-oom-cell — hosts=${args.hosts}, eps=${args.eventsPerSec}/s/host ` +
      `(target ${args.hosts * args.eventsPerSec}/s), retention=${args.retention}, ` +
      `dump-at=${args.dumpAtSec}s, total=${args.totalDurationSec}s`,
  );

  const outDir = await mkdtemp(join(tmpdir(), 'heap-profile-'));
  const snapshotPath = join(outDir, `aggregator.heapsnapshot`);
  const summaryPath = join(outDir, `aggregator.summary.json`);

  const grpcPort = await allocatePort();
  const httpPort = await allocatePort();
  let producer: SpawnedProcess | undefined;
  let aggregator: SpawnedProcess | undefined;

  try {
    producer = await spawnProducer({
      grpcPort,
      eventsPerSec: args.eventsPerSec,
      hostCount: args.hosts,
    });
    aggregator = await spawnAggregator({
      httpPort,
      producerUrl: `127.0.0.1:${grpcPort}`,
      retention: args.retention,
      heapDumpAtSec: args.dumpAtSec,
      heapDumpPath: snapshotPath,
    });

    console.log(`  measuring for ${args.totalDurationSec}s…`);
    console.log(`  snapshot scheduled at +${args.dumpAtSec}s`);
    console.log(`  → ${snapshotPath}`);

    // Wait for the heap dump to land + a bit of buffer for write
    // completion. The aggregator logs "heap snapshot written" to
    // stdout when v8.writeHeapSnapshot returns; we don't have a
    // listener on that stream (spawn.ts pipes silently), so the
    // safest signal is wall-clock past the scheduled dump time +
    // empirical write duration.
    await new Promise((r) => setTimeout(r, args.totalDurationSec * 1000));

    // Capture /metrics summary at end-of-run for comparison with
    // the in-snapshot state.
    const metricsR = await fetch(`http://127.0.0.1:${httpPort}/metrics`);
    const metrics = metricsR.ok ? await metricsR.json() : null;
    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          args,
          metrics,
          notes: [
            'Snapshot taken at HEAP_DUMP_AT_SEC into the aggregator process.',
            'Producer at firehose rate; conservation drift means actual deque size << target rate × dump-at-sec.',
          ],
        },
        null,
        2,
      ),
    );

    console.log(`\nsummary written: ${summaryPath}`);
    console.log(`snapshot (if written by aggregator): ${snapshotPath}`);
    console.log(
      `\nnext: pnpm exec tsx scripts/analyse-heap-snapshot.ts ${snapshotPath}`,
    );
  } finally {
    if (producer) await producer.stop('SIGTERM');
    if (aggregator) await aggregator.stop('SIGTERM');
  }
}

await main();
