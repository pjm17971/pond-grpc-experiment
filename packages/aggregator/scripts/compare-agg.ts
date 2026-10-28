/**
 * Run the Node and Rust aggregators side by side on one producer and
 * compare their `/live-agg` ticks row by row (same `ts` and host).
 *
 *   pnpm --filter @pond-experiment/aggregator exec tsx scripts/compare-agg.ts --P=20 --N=50 --seconds=75
 *
 * Both subscribe to the same producer stream, so they see the same
 * events. Fields from the 200 ms slice should match from the start;
 * the 1 m baseline fields only once both have run past one minute
 * (they started at slightly different times), so those are compared
 * for ticks after `--settle` seconds (default 65).
 */
import WebSocket from 'ws';
import {
  allocatePort,
  spawnAggregator,
  spawnProducer,
} from '@pond-experiment/dev-utils';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, Number(v)];
  }),
);
const P = args.P ?? 20;
const N = args.N ?? 50;
const seconds = args.seconds ?? 75;
const settle = args.settle ?? 65;

type Row = Record<string, unknown> & { ts: number; host: string };

const nodeEps = new Map<number, number>();
const rustEps = new Map<number, number>();

function collect(
  port: number,
  into: Map<string, Row>,
  frames: string[],
  eps: Map<number, number>,
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live-agg`);
  ws.on('message', (data) => {
    const text = data.toString();
    frames.push(text);
    const msg = JSON.parse(text);
    if (msg.type === 'aggregate-append') {
      for (const r of msg.rows) into.set(`${r.ts}|${r.host}`, r);
      if (msg.globals) eps.set(msg.globals.ts, msg.globals.events_per_sec);
    }
  });
  return ws;
}

const grpcPort = await allocatePort();
const producer = await spawnProducer({
  grpcPort,
  eventsPerSec: N,
  hostCount: P,
});
const nodePort = await allocatePort();
const rustPort = await allocatePort();
const producerUrl = `127.0.0.1:${grpcPort}`;
const node = await spawnAggregator({
  httpPort: nodePort,
  producerUrl,
  impl: 'node',
});
const rust = await spawnAggregator({
  httpPort: rustPort,
  producerUrl,
  impl: 'rust',
});
const nodeRows = new Map<string, Row>();
const rustRows = new Map<string, Row>();
const nodeFrames: string[] = [];
const rustFrames: string[] = [];
const a = collect(nodePort, nodeRows, nodeFrames, nodeEps);
const b = collect(rustPort, rustRows, rustFrames, rustEps);
const start = Date.now();
await new Promise((r) => setTimeout(r, seconds * 1000));
a.close();
b.close();
await Promise.all([node.stop(), rust.stop(), producer.stop()]);

// Fields of the 200 ms slice alone. (The anomaly counts also read the
// 1 m baseline, so they wait for `settle` with the baseline fields.)
const slice = ['n_current', 'cpu_min', 'cpu_max', 'current_avg', 'current_sd'];
const settleTs = start + settle * 1000;
const same = (r: Row, t: Row, fields: string[]) =>
  fields.every((f) => JSON.stringify(r[f]) === JSON.stringify(t[f]));
// `window_age_seconds` depends on when each aggregator started.
const allFields = (r: Row) =>
  Object.keys(r).filter((f) => f !== 'window_age_seconds');

// The first host of each producer batch: Node's partitions all emit when
// this host's event crosses a tick, so its row is built at the same
// moment in both. Expect identical rows: the 200 ms slice fields from
// the start, every field once both have a full minute.
const firstHost = 'api-1';
let firstSame = 0;
const firstDiff: string[] = [];
// Other hosts: Node emits them before their own crossing event arrives;
// pond-rs (split by hand) after. Count Rust minus Node `n_current`.
const otherOffset: Record<string, number> = {};
let onlyNode = 0;
let onlyRust = 0;
for (const [k, r] of nodeRows) {
  const t = rustRows.get(k);
  if (!t) {
    onlyNode++;
    continue;
  }
  if (r.host === firstHost) {
    const fields = r.ts >= settleTs ? allFields(r) : slice;
    if (same(r, t, fields)) firstSame++;
    else
      firstDiff.push(
        `${k}: node=${JSON.stringify(r)} rust=${JSON.stringify(t)}`,
      );
  } else {
    const d = String((t.n_current as number) - (r.n_current as number));
    otherOffset[d] = (otherOffset[d] ?? 0) + 1;
  }
}
for (const k of rustRows.keys()) if (!nodeRows.has(k)) onlyRust++;
// `events_per_sec` comes from one rolling on the whole series in both
// (no partitions), so it should match once both have a full second.
let epsSame = 0;
const epsDiff: string[] = [];
for (const [ts, v] of nodeEps) {
  const w = rustEps.get(ts);
  if (w === undefined || ts < start + 2000) continue;
  if (v === w) epsSame++;
  else epsDiff.push(`${ts}: node=${v} rust=${w}`);
}
const firstWithRows = (fs: string[]) =>
  fs.find((f) => f.includes('"aggregate-append"') && f.includes('"host"'));
const keyOrder = (f: string | undefined) =>
  f ? Object.keys(JSON.parse(f).rows[0]).join(',') : '';
console.log(
  JSON.stringify(
    {
      P,
      N,
      seconds,
      rowsOnlyInNode: onlyNode,
      rowsOnlyInRust: onlyRust,
      sameFieldOrder:
        keyOrder(firstWithRows(nodeFrames)) ===
        keyOrder(firstWithRows(rustFrames)),
      firstHost: {
        identical: firstSame,
        different: firstDiff.length,
        examples: firstDiff.slice(0, 3),
      },
      otherHostsRustMinusNodeNCurrent: otherOffset,
      eventsPerSec: {
        same: epsSame,
        different: epsDiff.length,
        examples: epsDiff.slice(0, 3),
      },
    },
    null,
    2,
  ),
);
