/**
 * Stat — a small label/value card. Used in the page summary, every
 * section header, and a few inline places.
 *
 * Two visual sizes: `sm` (compact, summary bar) and `md` (header
 * stats, default).
 */
export function Stat({
  label,
  value,
  size = 'md',
}: {
  label: string;
  value: number | string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`stat stat-${size}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
