import WebSocket from 'ws';
import { decode, type WireMsg } from '@pond-experiment/shared';

export type Probe = {
  /** All frames received so far, in arrival order. Read-only view; the probe owns the underlying buffer. */
  frames: ReadonlyArray<WireMsg>;
  /** Resolves when `predicate(frames)` returns true; rejects after timeout. */
  waitFor: (
    predicate: (frames: ReadonlyArray<WireMsg>) => boolean,
    timeoutMs?: number,
    label?: string,
  ) => Promise<void>;
  /** Close the underlying WebSocket. */
  close: () => void;
  /** Whether the server has closed the connection from its side. */
  isClosed: () => boolean;
};

/**
 * Connect a WebSocket probe that records each frame as it arrives.
 * Used by the E2E tests to assert on the snapshot+append protocol
 * without spinning up the React stack.
 */
export async function connectProbe(url: string): Promise<Probe> {
  const ws = new WebSocket(url);
  const frames: WireMsg[] = [];
  let closed = false;

  ws.on('message', (data: Buffer) => {
    frames.push(decode(data.toString()));
  });
  ws.on('close', () => {
    closed = true;
  });
  ws.on('error', () => {
    closed = true;
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`probe failed to connect to ${url} within 5000ms`)),
      5000,
    );
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return {
    frames,
    waitFor(predicate, timeoutMs = 3000, label) {
      const deadline = Date.now() + timeoutMs;
      return new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (predicate(frames)) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(
              new Error(
                `probe.waitFor${label ? ` (${label})` : ''} timed out after ${timeoutMs}ms; received ${frames.length} frames`,
              ),
            );
            return;
          }
          setTimeout(tick, 10);
        };
        tick();
      });
    },
    close() {
      ws.close();
    },
    isClosed() {
      return closed;
    },
  };
}
