import { useEffect, useRef, useState } from 'react';
import { cmd, formatMarks, offersFor } from '@saltmarket/shared/client';
import { HARBOR_VENUE_ID, type WorldSnapshot } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { act } from '../../store/act';
import { Badge, Button, Card, Meter } from '../../ui/primitives';
import { ReasonBody, ReasonPopover } from '../../ui/Reason';
import { formatSeconds, useCountdown } from '../../lib/time';
import { ease, prefersReducedMotion, spring, springEasing } from '../../styles/tokens.motion';
import { bundleText } from '../../lib/goods';
import './ship.css';

const CURED = 'cured_fish' as const;

/** The one decorative moment (FRONTEND.md §5): the card settles in on a spring when the ship docks. */
function useArrival(docked: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const was = useRef(docked);
  useEffect(() => {
    const el = ref.current;
    const arrived = docked && !was.current;
    was.current = docked;
    if (!el || !arrived) return;
    const still = prefersReducedMotion();
    const anim = el.animate(
      still
        ? [{ opacity: 0.6 }, { opacity: 1 }]
        : [
            { transform: 'translateY(10px) scale(0.98)', opacity: 0.6 },
            { transform: 'none', opacity: 1 },
          ],
      { duration: spring.duration * 1000, easing: still ? ease.linear : springEasing() },
    );
    return () => anim.cancel();
  }, [docked]);
  return ref;
}

export function ShipPanel() {
  const world = useGame((s) => s.world);
  return world ? <ShipCard world={world} /> : null;
}

function ShipCard({ world }: { world: WorldSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [sale, setSale] = useState<string | null>(null);
  const { ship } = world;
  const docked = ship.status === 'docked';
  const ref = useArrival(docked);
  const secs = useCountdown(docked ? ship.ticksToDeparture : ship.ticksToArrival, world.clock);
  const cure = world.catalog.recipes.find((r) => r.outputs.cured_fish);

  const captain = world.npcs.find((n) => n.id === ship.captainNpcId);
  const captainOffer = offersFor(world, HARBOR_VENUE_ID, CURED, 'buy').find((o) => o.owner.kind === 'captain' || o.owner.id === ship.captainNpcId);
  const held = world.me?.inventory[CURED] ?? 0;
  const left = Math.max(0, ship.volume - ship.filled);
  const qty = Math.min(held, captainOffer?.qty ?? left);
  const name = captain?.name ?? 'The Captain';

  async function sell() {
    if (!captainOffer) return;
    setBusy(true);
    const ack = await act(cmd({ t: 'sell', good: CURED, qty, venueId: HARBOR_VENUE_ID, minPricePips: captainOffer.pricePips }));
    setBusy(false);
    if (ack.ok && ack.result?.kind === 'trade') setSale(ack.message);
  }

  return (
    <Card
      className="ship"
      data-docked={docked}
      title={
        <>
          The ship <span className="ship-name">{ship.name}</span>
        </>
      }
      hint={docked ? <Badge tone="up">⚓ Docked</Badge> : <Badge>⛵ At sea</Badge>}
    >
      <div ref={ref} className="ship-body">
        <div className="ship-stats">
          <div className="ship-stat">
            <span className="stat-label">{docked ? 'Leaves in' : 'Docks in'}</span>
            <span className="ship-big num">{formatSeconds(secs)}</span>
          </div>
          <div className="ship-stat">
            <span className="stat-label">Pays up to, per cured fish</span>
            {captain ? (
              <ReasonPopover
                label={`${name} pays up to ${formatMarks(ship.ceilingPips)} marks per cured fish. Why?`}
                trigger={
                  <span className="ship-big ship-ceiling num">
                    {formatMarks(ship.ceilingPips)} <span className="unit">marks</span>
                  </span>
                }
              >
                <ReasonBody reason={captainOffer?.reason ?? captain.reasoning} who={name} />
              </ReasonPopover>
            ) : (
              <span className="ship-big ship-ceiling num">{formatMarks(ship.ceilingPips)}</span>
            )}
          </div>
          <div className="ship-stat ship-fill">
            <span className="stat-label num">
              Bought {ship.filled} of {ship.volume}
            </span>
            <Meter value={ship.filled} max={ship.volume} label={`Captain bought ${ship.filled} of ${ship.volume} cured fish`} />
          </div>
        </div>

        {docked ? (
          <div className="ship-action">
            {captainOffer && left > 0 ? (
              <>
                <p className="ship-line">
                  {name} is buying cured fish at <strong className="num gold">{formatMarks(captainOffer.pricePips)} marks</strong> each.
                  {held === 0 && <span className="muted"> You have none yet: cure some fish at your stall.</span>}
                </p>
                {world.me && (
                  <Button variant="primary" onClick={sell} disabled={busy || qty < 1}>
                    {qty > 0 ? `Sell ${qty} cured fish to ${name}` : 'No cured fish to sell'}
                  </Button>
                )}
              </>
            ) : (
              <p className="ship-line muted">The hold is full this visit. The ship will be back.</p>
            )}
          </div>
        ) : (
          <p className="ship-line muted">
            Will buy {ship.volume} cured fish. Cure fish at your stall now
            {cure ? ` (${bundleText(world.catalog, cure.inputs)} → ${bundleText(world.catalog, cure.outputs)})` : ''} so you have some when it
            docks.
          </p>
        )}
        {sale && (
          <p className="ship-sale" role="status">
            <span className="ship-sale-mark" aria-hidden="true">
              ✓
            </span>{' '}
            {sale}
          </p>
        )}
      </div>
    </Card>
  );
}
