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
 * Counters cover everything pond is currently buffering; event rate
 * is the trailing 1-minute count divided by 60; the indicator
 * mirrors the third tuple slot of `useRemoteLiveSeries`.
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
      <Stat label="Total events" value={totalEvents} size="sm" />
      <Stat label="Hosts" value={hostCount} size="sm" />
      <Stat
        label="Event rate"
        value={eventsPerSec != null ? `${eventsPerSec.toFixed(1)}/s` : '—'}
        size="sm"
      />
      <Stat label="Evicted" value={evictedTotal} size="sm" />
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
