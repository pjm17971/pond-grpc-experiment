import { HOSTS } from '@pond-experiment/shared';

type SimulatorParams = {
  eventsPerSec: number;
  hostCount: number;
  variability: number;
};

type Props = {
  params: SimulatorParams;
  onChange: (next: SimulatorParams) => void;
};

/**
 * The dashed-blue bar at the top of the dashboard: events/sec, host
 * count, and CPU variability sliders. Pure UI — actual generator lives
 * in `useSimulator`.
 */
export function SimulatorControls({ params, onChange }: Props) {
  return (
    <div className="sim-controls">
      <label className="sim-control">
        <span className="sim-label">Events/sec</span>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={params.eventsPerSec}
          onChange={(e) =>
            onChange({ ...params, eventsPerSec: parseInt(e.target.value, 10) })
          }
        />
        <span className="sim-value">{params.eventsPerSec}</span>
      </label>
      <label className="sim-control">
        <span className="sim-label">Hosts</span>
        <input
          type="range"
          min={1}
          max={HOSTS.length}
          step={1}
          value={params.hostCount}
          onChange={(e) =>
            onChange({ ...params, hostCount: parseInt(e.target.value, 10) })
          }
        />
        <span className="sim-value">{params.hostCount}</span>
      </label>
      <label className="sim-control">
        <span className="sim-label">Variability</span>
        <input
          type="range"
          min={0.05}
          max={0.6}
          step={0.05}
          value={params.variability}
          onChange={(e) =>
            onChange({ ...params, variability: parseFloat(e.target.value) })
          }
        />
        <span className="sim-value">±{params.variability.toFixed(2)}</span>
      </label>
    </div>
  );
}
