import { Stat } from '../Stat';

type Props = {
  totalEvents: number;
  hostCount: number;
  eventsPerSec: number | undefined;
  evictedTotal: number;
};

/**
 * The top row of small stat cards. Counters cover everything pond is
 * currently buffering. Event rate is the trailing 1-minute count
 * divided by 60.
 */
export function PageSummary({
  totalEvents,
  hostCount,
  eventsPerSec,
  evictedTotal,
}: Props) {
  return (
    <div className="page-summary">
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
