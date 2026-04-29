import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const protoPath = join(here, '..', 'proto', 'events.proto');

/**
 * Hand-written `.proto` mirrors the `as const` schema in M2 — the
 * codegen-from-schema helper that would let us drop this test is the
 * deliberate library-design target captured in
 * `friction-notes/M2.md`. Until then, this regex-parse keeps the two
 * declarations from drifting silently.
 */
describe('proto ↔ schema drift', () => {
  it('Event fields mirror the schema columns in order, by name and kind', () => {
    const source = readFileSync(protoPath, 'utf8');

    const messageMatch = /message\s+Event\s*\{([\s\S]*?)\}/m.exec(source);
    expect(messageMatch, 'Event message not found in events.proto').toBeTruthy();

    // Strip line comments so they don't confuse the field regex.
    const body = messageMatch![1].replace(/\/\/[^\n]*/g, '');

    const fieldRegex = /^\s*([a-z0-9_]+)\s+([a-z0-9_]+)\s*=\s*\d+\s*;/gim;
    const fields: Array<{ type: string; name: string }> = [];
    for (const match of body.matchAll(fieldRegex)) {
      fields.push({ type: match[1], name: match[2] });
    }

    expect(fields).toHaveLength(schema.length);

    // Allowed proto types per schema kind. `int64` for time is the
    // canonical pair (epoch ms); the column name is allowed to suffix
    // with `_ms` since proto convention prefers explicit units.
    const KIND_TO_PROTO: Record<string, readonly string[]> = {
      time: ['int64'],
      number: ['double', 'float', 'int64', 'int32'],
      string: ['string'],
      boolean: ['bool'],
    };

    schema.forEach((col, i) => {
      const f = fields[i];
      const expectedNames =
        col.kind === 'time' ? [col.name, `${col.name}_ms`] : [col.name];
      expect(
        expectedNames,
        `field #${i}: proto name '${f.name}' does not match schema column '${col.name}'`,
      ).toContain(f.name);

      const allowed = KIND_TO_PROTO[col.kind] ?? [];
      expect(
        allowed,
        `field #${i} (${col.name}): proto type '${f.type}' not in allowed types for kind '${col.kind}'`,
      ).toContain(f.type);
    });
  });
});
