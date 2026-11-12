import { useState } from 'react';
import { cmd, formatMarks } from '@saltmarket/shared/client';
import type { Catalog, PlayerView, WorldSnapshot } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { act } from '../../store/act';
import { Badge, Button, Card, Meter } from '../../ui/primitives';
import { JobProgress } from '../../ui/Progress';
import { formatSeconds, useCountdown } from '../../lib/time';
import { GATHER_HINT, bundleText, goodLabel, type Good } from '../../lib/goods';
import './stall.css';

type Recipe = Catalog['recipes'][number];

function Inventory({ me, catalog }: { me: PlayerView; catalog: Catalog }) {
  const total = Object.values(me.inventory).reduce((a, b) => a + b, 0);
  return (
    <div className="inv" aria-label="Your goods">
      {catalog.goods.map((g) => {
        const n = me.inventory[g.id] ?? 0;
        return (
          <div key={g.id} className="inv-item" data-empty={n === 0}>
            <span className="inv-qty num">{n}</span>
            <span className="inv-name">{g.name}</span>
          </div>
        );
      })}
      {total === 0 && <p className="inv-empty muted">Your stall is empty. Gather something to get started.</p>}
    </div>
  );
}

/** What stops this recipe right now, in plain words (or null if it can start). */
function blocker(r: Recipe, me: PlayerView, catalog: Catalog): string | null {
  if (me.stall.shuttered) return 'Your stall is shuttered until the rent is paid.';
  const missing = (Object.entries(r.inputs) as [Good, number][])
    .map(([g, need]) => ({ g, short: need - (me.inventory[g] ?? 0) }))
    .filter((m) => m.short > 0);
  if (missing.length > 0) {
    return `Need ${missing
      .map(({ g, short }) => {
        const where = GATHER_HINT[g];
        return `${short} more ${goodLabel(catalog, g)}${where ? ` (gather at ${where})` : g === 'barrel' ? ' (craft one first)' : ''}`;
      })
      .join(', ')}.`;
  }
  if (me.stall.crafting.length >= me.stall.craftSlots) return 'Your workbench is busy. Wait for the current job.';
  return null;
}

function RecipeRow({ recipe, world, me }: { recipe: Recipe; world: WorldSnapshot; me: PlayerView }) {
  const [busy, setBusy] = useState(false);
  const why = blocker(recipe, me, world.catalog);
  const secs = Math.ceil((recipe.ticks * world.clock.realMsPerTick) / 1000);
  async function craft() {
    setBusy(true);
    await act(cmd({ t: 'craft', recipe: recipe.id }));
    setBusy(false);
  }
  return (
    <li className="recipe">
      <div className="recipe-info">
        <strong>{recipe.name}</strong>
        <span className="recipe-io num">
          {bundleText(world.catalog, recipe.inputs)} <span aria-hidden="true">→</span>
          <span className="sr-only">makes</span> <span className="recipe-out">{bundleText(world.catalog, recipe.outputs)}</span>
        </span>
        <span className="recipe-why muted" id={`why-${recipe.id}`}>
          {why ?? `Takes about ${formatSeconds(secs)}.`}
        </span>
      </div>
      <Button variant="primary" onClick={craft} disabled={busy || why !== null} aria-describedby={`why-${recipe.id}`}>
        {recipe.name}
      </Button>
    </li>
  );
}

function JobRow({ job, world }: { job: PlayerView['stall']['crafting'][number]; world: WorldSnapshot }) {
  const recipe = world.catalog.recipes.find((r) => r.id === job.recipe);
  const secs = useCountdown(Math.max(0, job.doneTick - world.clock.tick), world.clock);
  const name = recipe?.name ?? job.recipe;
  return (
    <li className="job">
      <div className="job-head">
        <span>
          {name}
          {recipe && <span className="muted"> → {bundleText(world.catalog, recipe.outputs)}</span>}
        </span>
        <span className="muted num">{secs > 0 ? `ready in ${formatSeconds(secs)}` : 'finishing…'}</span>
      </div>
      <JobProgress startedTick={job.startedTick} doneTick={job.doneTick} clock={world.clock} label={`${name} progress`} />
    </li>
  );
}

function Upkeep({ me }: { me: PlayerView }) {
  const [busy, setBusy] = useState(false);
  const { stall } = me;
  const cost = stall.upgradeCostPips;
  async function upgrade() {
    setBusy(true);
    await act(cmd({ t: 'upgradeStall' }));
    setBusy(false);
  }
  return (
    <div className="upkeep">
      <div className="upkeep-line">
        <span className="muted">Rent</span>
        <span className="num">
          {formatMarks(stall.rentPerDayPips)} marks a day
          {stall.rentGraceDaysLeft > 0 && (
            <span className="muted">
              {' '}
              · free for {stall.rentGraceDaysLeft} more {stall.rentGraceDaysLeft === 1 ? 'day' : 'days'}
            </span>
          )}
        </span>
      </div>
      {stall.arrearsPips > 0 && (
        <p className="upkeep-warn" role="status">
          You owe {formatMarks(stall.arrearsPips)} marks in rent.{stall.shuttered ? ' The stall stays shuttered until it is paid.' : ''}
        </p>
      )}
      <div className="upkeep-line">
        <span className="muted">Workbench</span>
        <span className="num">
          Level {stall.level} of {stall.maxLevel} · {stall.craftSlots} {stall.craftSlots === 1 ? 'job' : 'jobs'} at a time
        </span>
      </div>
      {cost !== null ? (
        <Button size="sm" onClick={upgrade} disabled={busy || me.marksPips < cost} className="upkeep-btn">
          Upgrade for {formatMarks(cost)} marks
        </Button>
      ) : (
        <span className="muted upkeep-max">Fully upgraded</span>
      )}
    </div>
  );
}

/** Shops you backed: payouts until they reach the cap (125% of what you put in). */
function Stakes({ me }: { me: PlayerView }) {
  if (me.investments.length === 0) return null;
  return (
    <div className="stakes">
      <h3 className="stakes-h">Shops you back</h3>
      <ul>
        {me.investments.map((i) => (
          <li key={i.npcId} className="stake">
            <div className="stake-head">
              <span>
                {i.npcName}
                {!i.active && <span className="muted"> · paid in full</span>}
              </span>
              <span className="num">
                <span className="gold">{formatMarks(i.paidOutPips)}</span> <span className="muted">of {formatMarks(i.capPips)} marks back</span>
              </span>
            </div>
            <Meter value={i.paidOutPips} max={i.capPips} label={`${i.npcName} has paid back ${formatMarks(i.paidOutPips)} of ${formatMarks(i.capPips)} marks`} />
            <span className="muted stake-sub num">You put in {formatMarks(i.principalPips)} marks</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StallPanel() {
  const world = useGame((s) => s.world);
  const me = world?.me;
  if (!world || !me) return null;
  const { stall } = me;
  return (
    <Card
      title="Your stall"
      hint={stall.shuttered ? <Badge tone="closed">✕ Shuttered</Badge> : <span className="num">{stall.crafting.length} of {stall.craftSlots} busy</span>}
      className="stall"
    >
      <Inventory me={me} catalog={world.catalog} />
      {stall.crafting.length > 0 && (
        <ul className="jobs" aria-label="Crafting now">
          {stall.crafting.map((j) => (
            <JobRow key={j.id} job={j} world={world} />
          ))}
        </ul>
      )}
      <ul className="recipes">
        {world.catalog.recipes.map((r) => (
          <RecipeRow key={r.id} recipe={r} world={world} me={me} />
        ))}
      </ul>
      <Stakes me={me} />
      <Upkeep me={me} />
    </Card>
  );
}
