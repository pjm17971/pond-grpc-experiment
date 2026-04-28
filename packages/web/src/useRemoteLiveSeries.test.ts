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
});
