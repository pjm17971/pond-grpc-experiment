/**
 * Streaming heap snapshot analyser for the column-native-live-pipeline brief.
 *
 * V8 heap snapshots are formatted as one giant JSON object, but the
 * `nodes` array can be multi-GB on a saturation-cell snapshot —
 * larger than V8's max string length (`0x1fffffe8` ≈ 512 MB). Naive
 * `readFileSync` + `JSON.parse` blows up at the `readFileSync` step.
 *
 * The snapshot format's redeeming property: every section is flat.
 * `nodes` and `edges` are comma-separated integers in fixed-width
 * stripes (7 ints per node, 3 per edge in standard V8 output);
 * `strings` is `["s0","s1",...]`. This analyser:
 *
 * 1. Reads the file as a byte stream.
 * 2. Parses the small `meta` block (always at the start, well under
 *    1 MB).
 * 3. Stream-parses the `nodes` section integer-by-integer using a
 *    tokeniser, aggregating `(type, name)` → `(count, bytes)` on
 *    the fly. Never materialises the array in memory.
 * 4. Skips the `edges` section (we don't need retainer-graph
 *    traversal for the brief's "what's allocated" framing).
 * 5. Parses the `strings` section (typically <100 MB on a 4 GB
 *    snapshot — the dictionary-encoded names) using a streaming
 *    string-array reader.
 * 6. Resolves name indices to strings and prints the per-bucket
 *    breakdown.
 *
 *   pnpm exec tsx scripts/analyse-heap-snapshot.ts <path-to-.heapsnapshot>
 */

import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';

type Meta = {
  node_fields: string[];
  node_types: (string | string[])[];
  edge_fields: string[];
  edge_types: (string | string[])[];
};

// ── Streaming byte-tokeniser ───────────────────────────────────────
// We walk the file as bytes (Uint8Array chunks) and feed them to a
// state machine that recognises:
//   - section-name keys (`"nodes"`, `"edges"`, `"strings"`)
//   - integer tokens (comma-separated, inside an int-array section)
//   - string-array entries (JSON strings inside a string array)
// The state machine never builds an intermediate string for the
// big-int sections. Strings are buffered character-by-character
// until the closing quote.

const CHUNK = 16 * 1024 * 1024; // 16 MB read chunks

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

/**
 * Parse the snapshot header (everything up to and including the
 * end of the `"snapshot": {...}` object) by reading a bounded
 * prefix of the file. Returns the parsed meta plus the byte
 * offset of the next character (which is `,\n` followed by
 * `"nodes":[`).
 */
async function readHeader(path: string): Promise<{ meta: Meta; offset: number }> {
  // Read first 256 KB — header is always small.
  const stream = createReadStream(path, { start: 0, end: 256 * 1024 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  // Find the matching `}` that closes the "snapshot" value.
  let depth = 0;
  let i = text.indexOf('{', text.indexOf('"snapshot"'));
  let end = -1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('could not find end of "snapshot" header');
  const headerJson = `{${text.slice(text.indexOf('"snapshot"'), end + 1)}}`;
  const parsed = JSON.parse(headerJson) as { snapshot: { meta: Meta } };
  // Next: skip past `,\n"nodes":[`
  let off = end + 1;
  while (off < text.length && text[off] !== '[') off++;
  off++; // step past the '['
  return { meta: parsed.snapshot.meta, offset: off };
}

/**
 * Stream the integer-array section starting at `startOffset` until
 * the matching `]`. Calls `onTuple(tuple)` for every `stride` ints
 * read. The tuple array is reused across calls (the callback must
 * not retain it). Returns the byte offset of the character AFTER
 * the closing `]`.
 */
async function streamIntArray(
  path: string,
  startOffset: number,
  stride: number,
  onTuple: (tuple: number[]) => void,
): Promise<number> {
  const stream = createReadStream(path, { start: startOffset, highWaterMark: CHUNK });
  const tuple = new Array<number>(stride);
  let field = 0;
  let cur = 0;
  let curHasDigit = false;
  let bytesConsumed = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (isDigit(b)) {
        cur = cur * 10 + (b - 0x30);
        curHasDigit = true;
      } else if (b === 0x2c /* , */ || b === 0x5d /* ] */ || b === 0x0a /* \n */) {
        if (curHasDigit) {
          tuple[field] = cur;
          field++;
          if (field === stride) {
            onTuple(tuple);
            field = 0;
          }
          cur = 0;
          curHasDigit = false;
        }
        if (b === 0x5d /* ] */) {
          stream.destroy();
          return startOffset + bytesConsumed + i + 1;
        }
      }
      // anything else (whitespace inside the chunk) just gets ignored
    }
    bytesConsumed += buf.length;
  }
  throw new Error('reached EOF without closing ] for int array');
}

/**
 * Skip past a known section by reading bytes until the next `]`
 * at depth 0 (we don't track JSON depth here — int arrays don't
 * contain nested `]`s, so a simple count is fine). Returns the
 * offset after the closing `]`.
 */
async function skipIntArray(path: string, startOffset: number): Promise<number> {
  const stream = createReadStream(path, { start: startOffset, highWaterMark: CHUNK });
  let bytesConsumed = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x5d /* ] */) {
        stream.destroy();
        return startOffset + bytesConsumed + i + 1;
      }
    }
    bytesConsumed += buf.length;
  }
  throw new Error('reached EOF skipping int array');
}

/**
 * Read the `strings` array — a JSON array of strings, comma-separated.
 * Returns the resolved array. Assumes the array fits in memory in
 * resolved form (typically <100 MB on a multi-GB snapshot).
 */
async function readStringArray(path: string, startOffset: number): Promise<string[]> {
  const stream = createReadStream(path, { start: startOffset, highWaterMark: CHUNK });
  const strings: string[] = [];
  // State: 'outside' (between strings), 'inside' (within a "..." string),
  // 'escape' (just saw a \ inside a string).
  type State = 'outside' | 'inside' | 'escape';
  let state: State = 'outside';
  let cur: Buffer[] = [];
  let curBuf = Buffer.alloc(4096);
  let curLen = 0;
  const appendByte = (b: number) => {
    if (curLen === curBuf.length) {
      cur.push(curBuf.subarray(0, curLen));
      curBuf = Buffer.alloc(curBuf.length * 2);
      curLen = 0;
    }
    curBuf[curLen++] = b;
  };
  const finishString = () => {
    if (curLen > 0) cur.push(curBuf.subarray(0, curLen));
    const s = Buffer.concat(cur).toString('utf8');
    // Decode JSON escapes via JSON.parse on a quoted wrapper. Small
    // per-string parse overhead, but correctness > speed here.
    try {
      strings.push(JSON.parse(`"${s}"`));
    } catch {
      strings.push(s); // fallback for malformed (shouldn't happen)
    }
    cur = [];
    curBuf = Buffer.alloc(4096);
    curLen = 0;
  };
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (state === 'outside') {
        if (b === 0x22 /* " */) state = 'inside';
        else if (b === 0x5d /* ] */) {
          stream.destroy();
          return strings;
        }
      } else if (state === 'inside') {
        if (b === 0x5c /* \ */) {
          appendByte(b);
          state = 'escape';
        } else if (b === 0x22 /* " */) {
          finishString();
          state = 'outside';
        } else {
          appendByte(b);
        }
      } else if (state === 'escape') {
        appendByte(b);
        state = 'inside';
      }
    }
  }
  return strings;
}

function fmtBytes(n: number): string {
  if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: analyse-heap-snapshot.ts <path-to-.heapsnapshot>');
    process.exit(1);
  }
  const sizeMb = statSync(path).size / 1024 / 1024;
  console.log(`analysing ${path} (${sizeMb.toFixed(0)} MB)…`);

  // 1. Header.
  const { meta, offset: afterNodesOpenBracket } = await readHeader(path);
  const nodeFields = meta.node_fields;
  const nodeTypeNames = (meta.node_types[nodeFields.indexOf('type')] ?? []) as string[];
  const stride = nodeFields.length;
  const typeFieldIdx = nodeFields.indexOf('type');
  const nameFieldIdx = nodeFields.indexOf('name');
  const selfSizeFieldIdx = nodeFields.indexOf('self_size');
  console.log(`  node_fields: ${nodeFields.join(', ')} (stride=${stride})`);

  // 2. Aggregate (type, name) → (count, bytes) across all nodes.
  // We only need `type` (small enum) and `name` (string index) for
  // bucketing, plus `self_size` (bytes). Skip every other field.
  type Bucket = { count: number; bytes: number };
  const byKey = new Map<string, Bucket>();
  let totalSelfBytes = 0;
  let totalNodes = 0;
  console.log('  streaming nodes section…');
  const afterNodes = await streamIntArray(path, afterNodesOpenBracket, stride, (tuple) => {
    const typeIdx = tuple[typeFieldIdx];
    const nameIdx = tuple[nameFieldIdx];
    const selfSize = tuple[selfSizeFieldIdx];
    // Use `${typeIdx}|${nameIdx}` as the temporary key — much faster
    // than concatenating type-name strings before we've loaded the
    // string table.
    const key = `${typeIdx}|${nameIdx}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.count += 1;
      cur.bytes += selfSize;
    } else {
      byKey.set(key, { count: 1, bytes: selfSize });
    }
    totalSelfBytes += selfSize;
    totalNodes++;
  });
  console.log(`  nodes: ${totalNodes.toLocaleString()}, total self-size: ${fmtBytes(totalSelfBytes)}`);

  // 3. Skip edges.
  console.log('  skipping edges section…');
  // Find `"edges":[` from afterNodes.
  const edgeOpenStream = createReadStream(path, {
    start: afterNodes,
    end: afterNodes + 4096,
  });
  let edgeOpenText = '';
  for await (const chunk of edgeOpenStream) edgeOpenText += (chunk as Buffer).toString('utf8');
  const edgesBracketRelOff = edgeOpenText.indexOf('"edges":[');
  if (edgesBracketRelOff < 0) throw new Error('could not find "edges":[');
  const afterEdgesOpenBracket = afterNodes + edgesBracketRelOff + '"edges":['.length;
  const afterEdges = await skipIntArray(path, afterEdgesOpenBracket);

  // 4. Read strings. V8 snapshots have several intermediate
  // sections between `edges` and `strings` —
  // `trace_function_infos`, `trace_tree`, `samples`, `locations`.
  // Scan forward from afterEdges until we hit `"strings":[`.
  console.log('  scanning for strings section…');
  const stringsKey = '"strings":[';
  let afterStringsOpenBracket = -1;
  {
    const scanStream = createReadStream(path, {
      start: afterEdges,
      highWaterMark: CHUNK,
    });
    let carry = '';
    let consumed = 0;
    for await (const chunk of scanStream) {
      const text = (chunk as Buffer).toString('utf8');
      const combined = carry + text;
      const idx = combined.indexOf(stringsKey);
      if (idx >= 0) {
        afterStringsOpenBracket = afterEdges + consumed - carry.length + idx + stringsKey.length;
        scanStream.destroy();
        break;
      }
      // Keep last (stringsKey.length - 1) bytes as carry in case
      // the key straddles two chunks.
      carry = combined.slice(-stringsKey.length);
      consumed += text.length;
    }
  }
  if (afterStringsOpenBracket < 0) throw new Error('could not find "strings":[');
  const strings = await readStringArray(path, afterStringsOpenBracket);
  console.log(`  strings: ${strings.length.toLocaleString()}`);

  // 5. Resolve and present.
  type Resolved = { typeName: string; name: string; count: number; bytes: number };
  const resolved: Resolved[] = [];
  for (const [k, v] of byKey) {
    const [tIdxStr, nIdxStr] = k.split('|');
    const tIdx = Number(tIdxStr);
    const nIdx = Number(nIdxStr);
    resolved.push({
      typeName: nodeTypeNames[tIdx] ?? `type#${tIdx}`,
      name: strings[nIdx] ?? '',
      count: v.count,
      bytes: v.bytes,
    });
  }
  resolved.sort((a, b) => b.bytes - a.bytes);

  const fmtCount = (n: number) => n.toLocaleString().padStart(14);
  const fmtBytesPad = (n: number) => fmtBytes(n).padStart(11);

  console.log(`\n── top 25 buckets by self-size ──`);
  console.log(
    `  ${'type::name'.padEnd(54)} ${'count'.padStart(14)} ${'bytes'.padStart(11)}`,
  );
  console.log(`  ${'─'.repeat(54)} ${'─'.repeat(14)} ${'─'.repeat(11)}`);
  for (const r of resolved.slice(0, 25)) {
    const key = `${r.typeName}::${r.name}`;
    const trimmed = key.length > 54 ? key.slice(0, 51) + '…' : key;
    console.log(
      `  ${trimmed.padEnd(54)} ${fmtCount(r.count)} ${fmtBytesPad(r.bytes)}`,
    );
  }

  // Brief-relevant counts. Search across all type buckets sharing
  // the name so we catch e.g. concatenated strings of "Event" too.
  console.log(`\n── brief-relevant counts (matched by name) ──`);
  const relevantNames = [
    'Event',
    'Time',
    'TimeRange',
    'Interval',
    'EventKey',
    'Date',
    'LiveSeries',
    'LiveFusedRolling',
    'LivePartitionedFusedRolling',
    'LivePartitionedSeries',
    'LivePartitionedSyncRolling',
    'LiveRollingAggregation',
    'LiveReduce',
    'HostTick',
    'Array',
    'Float64Array',
    'Uint8Array',
  ];
  for (const name of relevantNames) {
    let count = 0;
    let bytes = 0;
    for (const r of resolved) {
      if (r.name === name) {
        count += r.count;
        bytes += r.bytes;
      }
    }
    if (count > 0) {
      const perInstance = Math.round(bytes / count);
      console.log(
        `  ${name.padEnd(34)} ${fmtCount(count)} ${fmtBytesPad(bytes)}   (~${perInstance} B/instance)`,
      );
    } else {
      console.log(`  ${name.padEnd(34)} ${'(none found)'.padStart(28)}`);
    }
  }

  // Per-event-cluster framing for the brief.
  let eventCluster = 0;
  let eventCount = 0;
  for (const r of resolved) {
    if (r.name === 'Event' || r.name === 'Time' || r.name === 'Date') {
      eventCluster += r.bytes;
      if (r.name === 'Event') eventCount += r.count;
    }
  }
  if (eventCluster > 0) {
    const pct = ((eventCluster / totalSelfBytes) * 100).toFixed(1);
    console.log(`\n── per-event cluster (Event + Time + Date self-size) ──`);
    console.log(`  ${fmtBytes(eventCluster)} = ${pct}% of total node self-size`);
    if (eventCount > 0) {
      console.log(`  ${(eventCluster / eventCount).toFixed(0)} B per Event object (cluster total ÷ Event count)`);
    }
  }
}

await main();
