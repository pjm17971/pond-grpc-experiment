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
 * for ticks after `--settle` seconds (default 65). Each aggregator joins
 * the producer stream on its own, so one can start a producer tick
 * earlier: `sameFirstEvent` says whether that happened, and rows that
 * differ only by last-bit rounding are counted apart. `SAMPLE_STRIDE` in
 * the environment reaches both aggregators.
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
// Host order within each tick's frame.
const nodeOrder = new Map<number, string>();
const rustOrder = new Map<number, string>();

function collect(
  port: number,
  into: Map<string, Row>,
  frames: string[],
  eps: Map<number, number>,
  order: Map<number, string>,
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live-agg`);
  ws.on('message', (data) => {
    const text = data.toString();
    frames.push(text);
    const msg = JSON.parse(text);
    if (msg.type === 'aggregate-append') {
      for (const r of msg.rows) into.set(`${r.ts}|${r.host}`, r);
      if (msg.globals) {
        eps.set(msg.globals.ts, msg.globals.events_per_sec);
        order.set(msg.globals.ts, msg.rows.map((r: Row) => r.host).join(','));
      }
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
const a = collect(nodePort, nodeRows, nodeFrames, nodeEps, nodeOrder);
const b = collect(rustPort, rustRows, rustFrames, rustEps, rustOrder);
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

// Every row should be identical: the 200 ms slice fields from the
// start, every field once both have a full minute.
let rowsSame = 0;
let rowsSameWholeRow = 0;
const rowsDiff: string[] = [];
// Rows whose differing fields are all numbers within 1e-12 of each other
// (relative): last-bit rounding, not a different count or value.
let rowsDiffRoundingOnly = 0;
const close = (x: unknown, y: unknown) =>
  typeof x === 'number' &&
  typeof y === 'number' &&
  Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y));
let onlyNode = 0;
let onlyRust = 0;
for (const [k, r] of nodeRows) {
  const t = rustRows.get(k);
  if (!t) {
    onlyNode++;
    continue;
  }
  const fields = r.ts >= settleTs ? allFields(r) : slice;
  if (same(r, t, fields)) {
    rowsSame++;
    if (r.ts >= settleTs) rowsSameWholeRow++;
  } else {
    const differing = fields.filter(
      (f) => JSON.stringify(r[f]) !== JSON.stringify(t[f]),
    );
    if (differing.every((f) => close(r[f], t[f]))) rowsDiffRoundingOnly++;
    rowsDiff.push(`${k}: node=${JSON.stringify(r)} rust=${JSON.stringify(t)}`);
  }
}
// Did both aggregators start from the same producer event? Each one
// joins the producer stream separately; if one joined a tick earlier it
// holds an extra event, and the rolling sums' rounding then differs in
// the last bits for as long as that history matters.
const firstCommon = [...nodeRows.keys()]
  .filter((k) => rustRows.has(k))
  .sort()[0];
const sameFirstEvent =
  firstCommon !== undefined &&
  nodeRows.get(firstCommon)!.window_age_seconds ===
    rustRows.get(firstCommon)!.window_age_seconds;
for (const k of rustRows.keys()) if (!nodeRows.has(k)) onlyRust++;
// `events_per_sec` comes from one rolling on the whole series in both
// (no partitions), so it should match once both have a full second.
let epsSame = 0;
let epsMissingInRust = 0;
const epsDiff: string[] = [];
for (const [ts, v] of nodeEps) {
  if (ts < start + 2000) continue;
  const w = rustEps.get(ts);
  if (w === undefined) {
    epsMissingInRust++;
    continue;
  }
  if (v === w) epsSame++;
  else epsDiff.push(`${ts}: node=${v} rust=${w}`);
}
let orderSame = 0;
let orderDifferent = 0;
for (const [ts, hosts] of nodeOrder) {
  const other = rustOrder.get(ts);
  if (other === undefined) continue;
  if (other === hosts) orderSame++;
  else orderDifferent++;
}
if (process.env.COMPARE_DUMP) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.COMPARE_DUMP, rowsDiff.join('\n'));
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
      hostOrderPerTick: { same: orderSame, different: orderDifferent },
      sampleStride: Number(process.env.SAMPLE_STRIDE ?? '1'),
      sameFirstEvent,
      hostRows: {
        identical: rowsSame,
        identicalWholeRowAfterSettle: rowsSameWholeRow,
        different: rowsDiff.length,
        differentOnlyInRounding: rowsDiffRoundingOnly,
        examples: rowsDiff.slice(0, 3),
      },
      eventsPerSec: {
        missingInRust: epsMissingInRust,
        same: epsSame,
        different: epsDiff.length,
        examples: epsDiff.slice(0, 3),
      },
    },
    null,
    2,
  ),
);
