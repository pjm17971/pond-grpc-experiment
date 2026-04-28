import { Stat } from '../Stat';

type Props = {
  totalEvents: number;
  hostCount: number;
  totalRequests: number | undefined;
  evictedTotal: number;
};

/**
 * The top row of small stat cards. Numbers are computed across the
 * full live series (not the visible window), so "Total events" reflects
 * everything pond is currently buffering.
 */
export function PageSummary({
  totalEvents,
  hostCount,
  totalRequests,
  evictedTotal,
}: Props) {
  return (
    <div className="page-summary">
      <Stat label="Total events" value={totalEvents} size="sm" />
      <Stat label="Hosts" value={hostCount} size="sm" />
      <Stat
        label="Total requests"
        value={totalRequests != null ? totalRequests.toLocaleString() : '—'}
        size="sm"
      />
      <Stat label="Evicted" value={evictedTotal} size="sm" />
    </div>
  );
}
