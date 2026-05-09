type Props = {
  hosts: readonly string[];
  hostColors: Record<string, string>;
  enabledHosts: Set<string>;
  /**
   * Hosts the server's most recent `aggregate-append` actually
   * shipped (the top-N cut + any hysteresis carry-overs). Hosts in
   * `hosts` but **not** here are visible-in-history but quiet right
   * now — they render with a faded class so the user can tell at a
   * glance which hosts are inside the current cut. Empty until the
   * first append arrives, in which case nothing is faded (no signal).
   */
  currentTopHosts: ReadonlySet<string>;
  onToggle: (host: string) => void;
  /**
   * Per-connection top-N. Drives the slider's value + the WS
   * control-message the hook ships when the slider moves. Server
   * clamps server-side too; the slider just gives the user a
   * sensible UI range.
   */
  topN: number;
  onTopNChange: (n: number) => void;
};

/**
 * Lower bound for the slider — `1` would ship a single row per tick,
 * legible but useless for cluster comparison. `2` is the lowest
 * value where a top-N chart still tells you anything.
 */
const TOP_N_MIN = 1;
/**
 * Upper bound — `15` is comfortably past the chart's SVG-cliff
 * threshold. Going higher means the chart turns into spaghetti and
 * the renderer starts dropping frames. Server clamps to
 * `max(hostCount, 1000)`, so the upper bound here is purely a UI
 * sanity cap.
 */
const TOP_N_MAX = 15;

/**
 * The chip row under the page summary. Three things share this row:
 *
 *   1. **Top-N slider** — server-side per-connection cut. Drag to
 *      change how many hosts the wire ships. The dashboard sends
 *      a `{type:'set-top-n', n}` control message on every input
 *      event; the server applies the new cut on the next tick.
 *      No client-side reconnect, no chart re-mount. Slider drag
 *      cost is one JSON message per change.
 *   2. **Host chips** — click to disable/enable a host. Disabled
 *      hosts are dropped from the chart memo's host iteration; the
 *      server can't see this toggle (it just filters by global
 *      cpu_avg ranking), so a "disabled" host that's in the
 *      server-side cut still arrives on the wire — the chart memo
 *      drops it client-side.
 *   3. **Faded chips** — visual cue: any host in `hosts` but **not**
 *      in `currentTopHosts` is currently outside the server's cut.
 *      Stays in the row (so the user can re-enable it) but
 *      visually de-emphasised so the eye reads the active cut at
 *      a glance.
 */
export function HostToggles({
  hosts,
  hostColors,
  enabledHosts,
  currentTopHosts,
  onToggle,
  topN,
  onTopNChange,
}: Props) {
  if (hosts.length === 0) return null;
  return (
    <div className="host-toggles">
      <span className="toggles-label">Hosts</span>
      {hosts.map((host) => {
        const enabled = enabledHosts.has(host);
        const inCut = currentTopHosts.has(host);
        // Three visual states:
        //  - enabled + inCut: full colour ("on")
        //  - enabled + !inCut: dimmed colour ("on faded") — visible
        //    in history (was in cut at some point in the 5min window)
        //    but not in the current frame's top-N
        //  - !enabled: greyed + struck-through ("off") regardless of
        //    cut membership
        const className = enabled
          ? inCut
            ? 'host-chip on'
            : 'host-chip on faded'
          : 'host-chip off';
        const color = hostColors[host];
        return (
          <button
            key={host}
            type="button"
            className={className}
            onClick={() => onToggle(host)}
            style={{ borderColor: color, color: enabled ? color : undefined }}
            title={
              enabled
                ? inCut
                  ? `${host} — currently in top-${topN}`
                  : `${host} — outside top-${topN} this tick`
                : `${host} — disabled`
            }
          >
            <span
              className="dot"
              style={{ background: enabled ? color : 'transparent' }}
            />
            {host}
          </button>
        );
      })}
      <label
        className="top-n-control"
        title={`Server-side per-connection top-N filter — drag to change how many hosts the wire ships per tick. Currently ${topN}.`}
      >
        <span className="top-n-label">Top-N</span>
        <input
          type="range"
          min={TOP_N_MIN}
          max={TOP_N_MAX}
          step={1}
          value={topN}
          onChange={(e) => onTopNChange(parseInt(e.target.value, 10))}
          className="top-n-slider"
          aria-label="top-N hosts"
        />
        <span className="top-n-value">{topN}</span>
      </label>
    </div>
  );
}
