import { formatMarks } from '@saltmarket/shared/client';
import { useGame } from '../../store/game';
import { formatClock, formatSeconds, useCountdown } from '../../lib/time';
import type { Clock, Ship } from '@saltmarket/shared/protocol';
import { WatchWeek } from '../timelapse/WatchWeek';
import './town.css';

function ShipStatus({ ship, clock }: { ship: Ship; clock: Clock }) {
  const docked = ship.status === 'docked';
  const secs = useCountdown(docked ? ship.ticksToDeparture : ship.ticksToArrival, clock);
  return (
    <div className="topbar-ship" data-docked={docked}>
      <span className="stat-label">Ship</span>
      {docked ? (
        <span className="stat-value">
          <span className="ship-name">{ship.name}</span> docked · leaves in <span className="num">{formatSeconds(secs)}</span>
        </span>
      ) : (
        <span className="stat-value">
          <span className="ship-name">{ship.name}</span> docks in <span className="num">{formatSeconds(secs)}</span>
        </span>
      )}
      <span className="stat-delta muted num">
        {docked
          ? `Buys cured fish up to ${formatMarks(ship.ceilingPips)} marks · ${ship.filled} of ${ship.volume} bought`
          : `Will buy ${ship.volume} cured fish, up to ${formatMarks(ship.ceilingPips)} marks each`}
      </span>
    </div>
  );
}

export function TopBar() {
  const clock = useGame((s) => s.world?.clock);
  const ship = useGame((s) => s.world?.ship);
  const purse = useGame((s) => s.world?.me?.marksPips);
  const name = useGame((s) => s.world?.me?.displayName);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <h1>Saltmarket</h1>
        {name && <span className="muted topbar-name">{name}'s stall</span>}
        {clock && <WatchWeek />}
      </div>
      <div className="topbar-stats">
        {purse !== undefined && (
          <div className="stat topbar-purse">
            <span className="stat-label">Purse</span>
            <span className="stat-value num">
              {formatMarks(purse)} <span className="unit">marks</span>
            </span>
          </div>
        )}
        {clock && (
          <div className="stat">
            <span className="stat-label">Town clock</span>
            <span className="stat-value num">
              {formatClock(clock)}
              {clock.paused ? ' · paused' : clock.speed !== 1 ? ` · ×${clock.speed}` : ''}
            </span>
          </div>
        )}
        {ship && clock && <ShipStatus ship={ship} clock={clock} />}
      </div>
    </header>
  );
}

export function EventBanner() {
  const events = useGame((s) => s.world?.events);
  if (!events || events.length === 0) return null;
  return (
    <div className="events" role="status">
      {events.map((e) => (
        <div key={e.id} className="banner" data-kind={e.kind}>
          <strong>{e.label}</strong>
          <span>{e.description}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnectionBanner() {
  const status = useGame((s) => s.status);
  if (status !== 'reconnecting') return null;
  return (
    <div className="banner conn" role="status">
      Reconnecting to the harbor…
    </div>
  );
}
