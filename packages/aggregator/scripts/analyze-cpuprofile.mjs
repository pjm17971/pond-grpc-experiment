// Quick CPU profile analyzer — reads a Chrome/V8 .cpuprofile and prints
// flat (self-time) and inclusive-time hot lists plus aggregate-by-script.
//
// Usage: node /tmp/analyze-cpuprofile.mjs <path>

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: analyze-cpuprofile.mjs <path>');
  process.exit(1);
}

const profile = JSON.parse(readFileSync(path, 'utf8'));
// V8 profile format: nodes (callFrame + hitCount), samples[], timeDeltas[].
const { nodes, samples, timeDeltas, startTime, endTime } = profile;
const totalUs = endTime - startTime; // microseconds
console.log(`profile: ${path}`);
console.log(`duration: ${(totalUs / 1e6).toFixed(2)}s`);
console.log(`nodes: ${nodes.length}, samples: ${samples.length}\n`);

const byId = new Map();
for (const n of nodes) byId.set(n.id, n);

// Self-time per node from samples (each sample charges the leaf node
// for the duration of timeDeltas[i]).
const self = new Map(); // id -> us
for (let i = 0; i < samples.length; i++) {
  const id = samples[i];
  const dt = timeDeltas[i] ?? 0;
  self.set(id, (self.get(id) ?? 0) + dt);
}

// Inclusive time: sum self time of node + descendants.
const inc = new Map(); // id -> us
const computeInc = (id) => {
  if (inc.has(id)) return inc.get(id);
  const node = byId.get(id);
  let total = self.get(id) ?? 0;
  if (node?.children) for (const c of node.children) total += computeInc(c);
  inc.set(id, total);
  return total;
};
for (const n of nodes) computeInc(n.id);

const fmtFrame = (cf) => {
  const fn = cf.functionName || '(anonymous)';
  const url = (cf.url || '').replace(/.*\//, '');
  const line = cf.lineNumber ?? -1;
  return `${fn}  [${url}:${line}]`;
};

const us = (n) => `${(n / 1000).toFixed(1)}ms`;
const pct = (n) => `${((n / totalUs) * 100).toFixed(1)}%`;

const ranked = (map) =>
  [...map.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => ({ id, v, frame: fmtFrame(byId.get(id).callFrame) }));

console.log('── Top 25 by self time ──────────────────');
for (const r of ranked(self).slice(0, 25)) {
  console.log(`${us(r.v).padStart(10)} ${pct(r.v).padStart(6)}  ${r.frame}`);
}

console.log('\n── Top 25 by inclusive time ─────────────');
for (const r of ranked(inc).slice(0, 25)) {
  console.log(`${us(r.v).padStart(10)} ${pct(r.v).padStart(6)}  ${r.frame}`);
}

// Aggregate by script (URL), self time only — best signal of
// "where the time is going" at module-level.
console.log('\n── Self time by script ──────────────────');
const byScript = new Map();
for (const [id, t] of self) {
  if (t === 0) continue;
  const cf = byId.get(id).callFrame;
  const url = cf.url || '(no url)';
  const key = url.replace(/.*node_modules\//, 'node_modules/').replace(/.*pond-grpc-experiment\//, '');
  byScript.set(key, (byScript.get(key) ?? 0) + t);
}
const scripts = [...byScript.entries()].sort((a, b) => b[1] - a[1]);
for (const [url, t] of scripts.slice(0, 20)) {
  console.log(`${us(t).padStart(10)} ${pct(t).padStart(6)}  ${url || '(empty)'}`);
}
