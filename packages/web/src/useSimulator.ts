import { useEffect, useRef } from 'react';
import type { LiveSeries } from 'pond-ts';
import { schema } from '@pond-experiment/shared';
import { HOSTS, HOST_MEANS } from './dashboardSchema';

export type SimulatorParams = {
  /** Generator tick rate. The interval period is `1000 / eventsPerSec`. */
  eventsPerSec: number;
  /** Number of hosts to push events for, sliced from `HOSTS`. */
  hostCount: number;
  /** Width of the random ±range around each host's mean CPU. */
  variability: number;
};

/**
 * Push synthetic metrics events into a LiveSeries on a configurable
 * interval. Demonstrates the "data ingest" half of pond-ts: a real app
 * would be driven by a WebSocket / EventSource / fetch loop instead.
 *
 * Implementation note: the host count and variability live in a ref so
 * the interval doesn't restart on every slider tick — only an
 * events/sec change triggers a fresh interval (because the tick period
 * itself depends on it).
 */
export function useSimulator(
  liveSeries: LiveSeries<typeof schema>,
  params: SimulatorParams,
): void {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const tickMs = 1000 / params.eventsPerSec;
    const id = setInterval(() => {
      const { hostCount, variability } = paramsRef.current;
      const t = new Date();
      const n = Math.min(hostCount, HOSTS.length);
      for (let i = 0; i < n; i++) {
        const mean = HOST_MEANS[i % HOST_MEANS.length];
        const cpu = mean + (Math.random() - 0.5) * variability;
        liveSeries.push([
          t,
          Math.max(0, Math.min(1, cpu)),
          Math.floor(Math.random() * 200),
          HOSTS[i],
        ]);
      }
    }, tickMs);
    return () => clearInterval(id);
  }, [liveSeries, params.eventsPerSec]);
}
