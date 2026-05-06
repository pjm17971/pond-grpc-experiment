import { Stat } from '../Stat';
import type { ConnectionStatus } from '../useRemoteLiveSeries';

type Props = {
  totalEvents: number;
  hostCount: number;
  eventsPerSec: number | undefined;
  evictedTotal: number;
  connectionStatus: ConnectionStatus;
};

/**
 * The top row of small stat cards plus a WS connection indicator.
 *
 * Step 6 — every stat below now reflects the **gRPC firehose** at
 * the aggregator's ingest hop, sourced from the `/live-agg` wire's
 * per-tick `GlobalsTick`:
 *
 *   - Total events: cumulative since aggregator start (monotonic
 *     across reconnects, unbounded by the dashboard's retention).
 *   - Event rate: raw events ingested in the trailing 1s window.
 *   - Evicted: cumulative LiveSeries retention evictions.
 *
 * Pre-step-6 servers don't ship globals; the displayed values fall
 * back to "—" / "—/s" when `eventsPerSec` is undefined and 0 for
 * the integer fields.
 */
export function PageSummary({
  totalEvents,
  hostCount,
  eventsPerSec,
  evictedTotal,
  connectionStatus,
}: Props) {
  return (
    <div className="page-summary">
      <ConnectionIndicator status={connectionStatus} />
      <Stat label="Total events" value={totalEvents.toLocaleString()} size="sm" />
      <Stat label="Hosts" value={hostCount} size="sm" />
      <Stat
        label="Event rate"
        value={
          eventsPerSec != null
            ? `${eventsPerSec.toLocaleString()}/s`
            : '—'
        }
        size="sm"
      />
      <Stat
        label="Evicted"
        value={evictedTotal.toLocaleString()}
        size="sm"
      />
    </div>
  );
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting',
  connected: 'live',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
};

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <div
      className={`connection-indicator connection-indicator-${status}`}
      role="status"
      aria-label={`connection ${status}`}
    >
      <span className="connection-dot" />
      <span className="connection-label">{STATUS_LABEL[status]}</span>
    </div>
  );
}
