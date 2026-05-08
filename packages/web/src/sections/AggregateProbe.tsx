import { useEffect, useState } from 'react';
import type { RemoteAggregateState } from '../useRemoteAggregateSeries';

type Props = {
  /**
   * Aggregate stream state, owned by `useDashboardData`. Single
   * subscription per dashboard tab — earlier drafts of this section
   * called `useRemoteAggregateSeries` directly, which doubled the
   * `/live-agg` WS connections (one for the probe, one for the
   * bands). The hook owner now passes the state in.
   */
  aggregate: RemoteAggregateState;
};

const STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting',
  connected: 'live',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
};

/**
 * "Behind the curtain" — what's actually arriving on the
 * `/live-agg` WebSocket. The dashboard's headlines look like a
 * 70k-events/sec firehose; under the hood the wire ships a small
 * stream of per-tick aggregates. This panel surfaces that wire-
 * level reality.
 *
 * Pre-cleanup the section also showed a per-host `cpu_avg` /
 * `cpu_sd` / `cpu_n` / age table — that data is already on the
 * chart, so the panel is now strictly wire-meta. Per-host
 * inspection happens in the chart itself.
 */
export function AggregateProbe({ aggregate }: Props) {
  const { status, counters } = aggregate;
  // Drive the freshness display off a 1Hz wall-clock state bump so
  // "last frame N s ago" keeps growing during a disconnect (when no
  // ticks arrive and React would otherwise not re-render). 1s is
  // fine for a meta panel; sub-second precision wouldn't read better.
  const [renderedAt, setRenderedAt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setRenderedAt(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Compute per-frame averages and rates from the running counters.
  // `lastFrameAt` is null until the first frame; treat that as
  // "waiting" rather than "0 ms ago".
  const avgFrameBytes =
    counters.totalFrames > 0
      ? counters.totalBytes / counters.totalFrames
      : 0;
  const avgEventsPerFrame =
    counters.totalFrames > 0 && counters.totalEvents > 0
      ? counters.totalEvents / counters.totalFrames
      : 0;
  const sinceLastFrameMs =
    counters.lastFrameAt != null ? renderedAt - counters.lastFrameAt : null;

  return (
    <section className="metric-section aggregate-probe">
      <div className="section-header">
        <h2>Behind the curtain — /live-agg wire feed</h2>
        <div className="section-stats">
          <span
            className={`connection-indicator connection-indicator-${status}`}
            role="status"
            aria-label={`live-agg connection ${status}`}
          >
            <span className="connection-dot" />
            <span className="connection-label">
              /live-agg {STATUS_LABEL[status] ?? status}
            </span>
          </span>
        </div>
      </div>
      <p className="section-note">
        The headlines above read as the producer's gRPC firehose. On the
        wire, the dashboard receives a small stream of per-tick aggregate
        frames — ~5 frames/sec, each carrying one row per active host.
        These are the actual numbers crossing the socket.
      </p>
      <dl className="wire-stats">
        <div>
          <dt>Frames received</dt>
          <dd>
            <strong>{counters.totalFrames.toLocaleString()}</strong>
            {sinceLastFrameMs != null && (
              <span className="wire-stats-sub">
                last {formatAge(sinceLastFrameMs)} ago
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Bytes received</dt>
          <dd>
            <strong>{formatBytes(counters.totalBytes)}</strong>
            {avgFrameBytes > 0 && (
              <span className="wire-stats-sub">
                {formatBytes(avgFrameBytes)} / frame avg
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Latest frame</dt>
          <dd>
            <strong>{formatBytes(counters.latestFrameBytes)}</strong>
            {counters.latestFrameEvents > 0 && (
              <span className="wire-stats-sub">
                {counters.latestFrameEvents.toLocaleString()} raw events folded in
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Compression</dt>
          <dd>
            {avgEventsPerFrame > 0 ? (
              <>
                <strong>
                  {avgEventsPerFrame.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })}
                </strong>
                <span className="wire-stats-sub">raw events / frame avg</span>
              </>
            ) : (
              <strong>—</strong>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatAge(ms: number): string {
  // Negative values would imply the frame's wall-clock is in the
  // future relative to ours — really it's a tiny clock skew between
  // the React-state-bumped `renderedAt` and the message-arrival
  // `lastFrameAt`. Clamp at 0 so the readout never shows "future".
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return `${clamped} ms`;
  return `${(clamped / 1000).toFixed(1)} s`;
}
