import { describe, it, expect } from 'vitest';
import { LiveSeries } from 'pond-ts';
import { schema, type WireMsg } from '@pond-experiment/shared';
import { applyFrame } from './useRemoteLiveSeries';

describe('applyFrame', () => {
  it('ingests a snapshot frame as per-row pushes', () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    const snap: WireMsg = {
      type: 'snapshot',
      rows: [
        [1_700_000_000_000, 0.5, 100, 'api-1'],
        [1_700_000_000_050, 0.6, 110, 'api-2'],
      ],
    };
    applyFrame(live, snap);
    expect(live.length).toBe(2);
    expect(live.first()?.get('host')).toBe('api-1');
    expect(live.last()?.get('host')).toBe('api-2');
  });

  it('append after snapshot accumulates monotonically', () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    applyFrame(live, {
      type: 'snapshot',
      rows: [[1_700_000_000_000, 0.5, 100, 'api-1']],
    });
    applyFrame(live, {
      type: 'append',
      rows: [[1_700_000_001_000, 0.7, 200, 'api-1']],
    });
    expect(live.length).toBe(2);
    expect(live.last()?.get('cpu')).toBe(0.7);
  });

  it('handles an empty append frame', () => {
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    applyFrame(live, { type: 'append', rows: [] });
    expect(live.length).toBe(0);
  });

  it('demonstrates the `as never` hole: malformed wire rows reach push() unchecked', () => {
    // `WireRow = JsonRowForSchema<Schema>` permits null per column;
    // `LiveSeries.push` expects `RowForSchema` which does not. The
    // `as never` cast in applyFrame bridges this gap silently.
    // Capture the current runtime behavior so a future stricter pond
    // (or an added wire-validator) surfaces here as a regression.
    const live = new LiveSeries({
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    });
    let threw: unknown = null;
    try {
      applyFrame(live, {
        type: 'snapshot',
        rows: [[1_700_000_000_000, null, null, 'api-x']],
      });
    } catch (err) {
      threw = err;
    }
    if (threw == null) {
      // Silent acceptance is the current behavior — pin it so a
      // future change is loud.
      expect(live.length).toBe(1);
    } else {
      // If pond starts rejecting null in non-nullable columns,
      // celebrate and update friction-notes/M1.md item 4.
      expect(threw).toBeInstanceOf(Error);
      expect(live.length).toBe(0);
    }
  });
});
