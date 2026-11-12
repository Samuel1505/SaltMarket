import { useEffect, useRef, useState } from 'react';
import { cmd } from '@saltmarket/shared/client';
import type { Clock, GatherNode, WorldSnapshot } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { act } from '../../store/act';
import { Button, Card, Meter } from '../../ui/primitives';
import { formatSeconds, useCountdown } from '../../lib/time';
import { ease, hold, prefersReducedMotion } from '../../styles/tokens.motion';
import './gather.css';

type Pop = { id: number; text: string; leaving: boolean };

function goodName(world: WorldSnapshot, good: string): string {
  return (world.catalog.goods.find((g) => g.id === good)?.name ?? good).toLowerCase();
}

/** Cooldown bar: constant motion → linear, transform only, via WAAPI so it's off the main thread. */
function CooldownBar({ ticksLeft, clock }: { ticksLeft: number; clock: Clock }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || ticksLeft <= 0 || clock.paused || prefersReducedMotion()) return;
    const ms = ticksLeft * clock.realMsPerTick;
    const total = Math.max(ms, 1);
    const anim = el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: total, easing: ease.linear, fill: 'forwards' });
    return () => anim.cancel();
    // Re-anchor only when the remaining ticks or pacing change, not on every render.
  }, [ticksLeft, clock.realMsPerTick, clock.paused]);
  if (ticksLeft <= 0) return null;
  return (
    <span className="cooldown" aria-hidden="true">
      <span ref={ref} />
    </span>
  );
}

function NodeRow({
  node,
  world,
  ticksLeft,
  capReached,
}: {
  node: GatherNode;
  world: WorldSnapshot;
  ticksLeft: number;
  capReached: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [pops, setPops] = useState<Pop[]>([]);
  const secs = useCountdown(ticksLeft, world.clock);
  const cooling = ticksLeft > 0;
  const empty = node.yieldNow === 0;
  const good = goodName(world, node.good);

  async function gather() {
    setBusy(true);
    const ack = await act(cmd({ t: 'gather', node: node.id }), { quiet: true });
    setBusy(false);
    if (!ack.ok) return;
    const id = performance.now();
    setPops((p) => [...p.slice(-2), { id, text: ack.message, leaving: false }]);
    setTimeout(() => setPops((p) => p.map((x) => (x.id === id ? { ...x, leaving: true } : x))), hold.pop);
  }

  const status = empty
    ? 'Picked clean, refills overnight'
    : capReached
      ? 'Daily limit reached'
      : cooling
        ? `Catching your breath · ready in ${formatSeconds(secs)}`
        : `+${node.yieldNow} ${good} per trip`;

  return (
    <li className="node">
      <div className="node-info">
        <div className="node-title">
          <strong>{node.name}</strong>
          <span className="muted">{good}</span>
        </div>
        <Meter value={node.stock} max={node.cap} label={`${node.name} stock ${node.stock} of ${node.cap}`} />
        <span className="node-sub muted num">
          {node.stock} of {node.cap} left
          {node.gatherers24h > 0 ? ` · ${node.gatherers24h} gathering today` : ''}
        </span>
      </div>
      <div className="node-action">
        <Button
          variant="primary"
          className="gather-btn"
          disabled={busy || cooling || empty || capReached}
          onClick={gather}
          aria-describedby={`node-status-${node.id}`}
        >
          Gather {good}
          <CooldownBar ticksLeft={ticksLeft} clock={world.clock} />
        </Button>
        <span id={`node-status-${node.id}`} className="node-status muted num" aria-live="polite">
          {status}
        </span>
        <span className="pops" aria-live="polite">
          {pops.map((p) => (
            <span
              key={p.id}
              className="pop"
              data-leaving={p.leaving}
              onTransitionEnd={() => p.leaving && setPops((all) => all.filter((x) => x.id !== p.id))}
            >
              {p.text}
            </span>
          ))}
        </span>
      </div>
    </li>
  );
}

export function GatherPanel() {
  const world = useGame((s) => s.world);
  if (!world?.me) return null;
  const { gather } = world.me;
  const ticksLeft = Math.max(0, gather.readyAtTick - world.clock.tick);
  const capReached = gather.gatheredToday >= gather.dailyCap;
  return (
    <Card title="Gather" hint={<span className="num">Today {gather.gatheredToday} of {gather.dailyCap}</span>}>
      <ul className="nodes">
        {world.nodes.map((n) => (
          <NodeRow key={n.id} node={n} world={world} ticksLeft={ticksLeft} capReached={capReached} />
        ))}
      </ul>
    </Card>
  );
}
