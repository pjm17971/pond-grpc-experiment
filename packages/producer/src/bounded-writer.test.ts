import type { EventBatch } from '@pond-experiment/shared/grpc';
import { describe, expect, it } from 'vitest';
import { boundedWriter } from './grpc.js';

/** A stand-in for the gRPC call: accepts writes until `room` runs out. */
function fakeCall(room: number) {
  const written: number[] = [];
  let onDrain: (() => void) | undefined;
  return {
    written,
    call: {
      write(b: EventBatch) {
        written.push(b.events[0].timeMs);
        return written.length < room;
      },
      once(_e: 'drain', f: () => void) {
        onDrain = f;
      },
    },
    drain(more: number) {
      room = written.length + more;
      const f = onDrain;
      onDrain = undefined;
      f?.();
    },
  };
}

const batch = (t: number): EventBatch => ({
  events: [{ timeMs: t, cpu: 0.5, requests: 1, host: 'api-1' }],
});

describe('boundedWriter', () => {
  it('writes straight through while the stream has room', () => {
    const f = fakeCall(100);
    const { write } = boundedWriter(f.call, 3);
    for (let t = 1; t <= 5; t++) write(batch(t));
    expect(f.written).toEqual([1, 2, 3, 4, 5]);
  });

  it('queues after write() returns false and drops the oldest past max', () => {
    const f = fakeCall(2);
    const dropped: number[] = [];
    const { write } = boundedWriter(f.call, 3, (b) =>
      dropped.push(b.events[0].timeMs),
    );
    // 1 fits, 2 is accepted but write() says full; 3..7 wait in the
    // queue of 3, so 3 and 4 are dropped.
    for (let t = 1; t <= 7; t++) write(batch(t));
    expect(f.written).toEqual([1, 2]);
    expect(dropped).toEqual([3, 4]);
    // 'drain' with room for everything sends the rest in order.
    f.drain(100);
    expect(f.written).toEqual([1, 2, 5, 6, 7]);
    write(batch(8));
    expect(f.written).toEqual([1, 2, 5, 6, 7, 8]);
  });

  it('after close, drops what was queued and writes nothing more', () => {
    const f = fakeCall(1);
    const w = boundedWriter(f.call, 10);
    for (let t = 1; t <= 3; t++) w.write(batch(t));
    w.close();
    f.drain(100); // a late 'drain' after the stream ended
    w.write(batch(4));
    expect(f.written).toEqual([1]);
  });

  it('stops again if the stream fills while flushing', () => {
    const f = fakeCall(1);
    const { write } = boundedWriter(f.call, 10);
    for (let t = 1; t <= 4; t++) write(batch(t));
    expect(f.written).toEqual([1]);
    f.drain(1); // room for one more: 2 goes, 3 and 4 keep waiting
    expect(f.written).toEqual([1, 2]);
    write(batch(5)); // still blocked: queued behind 3, 4
    expect(f.written).toEqual([1, 2]);
    f.drain(100);
    expect(f.written).toEqual([1, 2, 3, 4, 5]);
  });
});
