type Props = {
  hosts: readonly string[];
  hostColors: Record<string, string>;
  enabledHosts: Set<string>;
  onToggle: (host: string) => void;
};

/**
 * The chip row under the page summary. Click a chip to remove that
 * host from every chart (and the alert/anomaly counts). Disabled chips
 * render greyed and struck through.
 */
export function HostToggles({
  hosts,
  hostColors,
  enabledHosts,
  onToggle,
}: Props) {
  if (hosts.length === 0) return null;
  return (
    <div className="host-toggles">
      <span className="toggles-label">Hosts</span>
      {hosts.map((host) => {
        const enabled = enabledHosts.has(host);
        const color = hostColors[host];
        return (
          <button
            key={host}
            type="button"
            className={`host-chip ${enabled ? 'on' : 'off'}`}
            onClick={() => onToggle(host)}
            style={{ borderColor: color, color: enabled ? color : undefined }}
          >
            <span
              className="dot"
              style={{ background: enabled ? color : 'transparent' }}
            />
            {host}
          </button>
        );
      })}
    </div>
  );
}
