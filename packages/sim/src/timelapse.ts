// "Watch a week" (GAME_LOOP §6, ARCHITECTURE §3.5): step a deep clone of the world, with optional scripted
// shocks, and produce one frame every 6 ticks. Never touches the live world. Used by the server's
// time-lapse and by `pnpm sim:week`.
import { ECONOMY, GOODS, type Good } from '@saltmarket/shared/config';
import type { TimelapseFrame } from '@saltmarket/shared/protocol';
import { applyCommand } from './commands.js';
import { forceBroke, scheduleEvent } from './events.js';
import { burnMintRatio, marksSupply, medianPrice, volume } from './metrics.js';
import { fmt } from './pricing/merchant-rules.js';
import { step } from './step.js';
import { addPlayer } from './world.js';
import { CAPTAIN, type SimEvent, type WorldState } from './types.js';

const E = ECONOMY;
const TPD = E.time.ticksPerDay;

export type Shock =
  | { kind: 'storm'; day: number }
  | { kind: 'flood'; good: Good; qty: number; day: number }
  | { kind: 'close_merchant'; npcId?: string | undefined; day: number; investDay?: number | undefined };

const NOTE_KINDS = new Set(['npc_decision', 'MERCHANT_CLOSED', 'MERCHANT_REOPENED', 'MERCHANT_RESCUED', 'captain_ceiling', 'event_start', 'event_end', 'ship_departed']);

export class Timelapse {
  readonly totalTicks: number;
  private readonly sb: WorldState;
  private readonly t0: number;
  private readonly closeAt = new Map<number, { npcId: string; investAt: number | null }>();
  private readonly investAt = new Map<number, string>();
  private offset = 0;
  private peakFish = { price: 0, day: 0 };
  private readonly milestones: string[] = [];

  constructor(world: WorldState, shocks: Shock[], days = 7) {
    this.sb = structuredClone(world);
    this.t0 = this.sb.tick;
    this.totalTicks = days * TPD;
    for (const sh of shocks) {
      const at = this.t0 + sh.day * TPD + 6;
      if (sh.kind === 'storm') scheduleEvent(this.sb, 'storm', at);
      if (sh.kind === 'flood') scheduleEvent(this.sb, 'flood', at, { good: sh.good, qty: sh.qty || 200 });
      if (sh.kind === 'close_merchant') this.closeAt.set(at, { npcId: sh.npcId ?? 'cooper', investAt: sh.investDay !== undefined ? this.t0 + sh.investDay * TPD + 6 : null });
    }
  }

  get done(): boolean {
    return this.offset >= this.totalTicks;
  }

  /** The sandbox world (for headless reports and tests). */
  get world(): Readonly<WorldState> {
    return this.sb;
  }

  /** Advance one frame (6 ticks) and describe it. */
  next(): TimelapseFrame {
    const sb = this.sb;
    const every = E.timelapse.frameEveryTicks;
    const notes: TimelapseFrame['notes'] = [];
    for (let k = 0; k < every; k++) {
      const ev: SimEvent[] = step(sb);
      const c = this.closeAt.get(sb.tick);
      if (c) { forceBroke(sb, c.npcId, ev); if (c.investAt !== null) this.investAt.set(c.investAt, c.npcId); }
      const inv = this.investAt.get(sb.tick);
      if (inv) {
        addPlayer(sb, 'investor-bot', 'A local investor');
        applyCommand(sb, 'investor-bot', { t: 'invest', npcId: inv, amountPips: E.merchants.investMin }, ev);
      }
      for (const e of ev) {
        if (e.private || !NOTE_KINDS.has(e.kind)) continue;
        const name = e.npcId ? (e.npcId === CAPTAIN ? 'Captain Maren' : sb.accounts[e.npcId]?.name ?? e.npcId) : 'Town';
        notes.push({ ...(e.npcId ? { npcId: e.npcId } : {}), name, code: e.kind, text: e.text.startsWith(`${name}: `) ? e.text.slice(name.length + 2) : e.text });
        if (e.kind.startsWith('MERCHANT_') || e.kind === 'event_start') this.milestones.push(`Day ${Math.floor((sb.tick - this.t0) / TPD) + 1}: ${e.text}`);
      }
    }
    this.offset += every;
    const prices = Object.fromEntries(GOODS.map((g) => [g, medianPrice(sb, g, every * 2)])) as Record<Good, number>;
    if (prices.fish > this.peakFish.price) this.peakFish = { price: prices.fish, day: Math.floor(this.offset / TPD) };
    return {
      tickOffset: this.offset, day: Math.floor(this.offset / TPD), hour: sb.tick % TPD, prices,
      volume: Object.fromEntries(GOODS.map((g) => [g, volume(sb, g, every).qty])) as Record<Good, number>,
      merchants: Object.values(sb.npcs).map((n) => ({ id: n.id, name: sb.accounts[n.id]!.name, pursePips: sb.accounts[n.id]!.marks, status: n.status })),
      captainCeilingPips: sb.ship.ceiling, shipDocked: sb.ship.docked, marksSupplyPips: marksSupply(sb),
      burnMintRatio: burnMintRatio(sb, 1),
      events: [...new Set(sb.events.filter((e) => e.start <= sb.tick && sb.tick < e.end).map((e) => e.kind))],
      notes: notes.slice(-6),
    };
  }

  summary(): string[] {
    return [
      `Fish peaked at ${fmt(this.peakFish.price)} marks on day ${this.peakFish.day + 1} and ended the week at ${fmt(medianPrice(this.sb, 'fish', TPD))} marks.`,
      `Captain Maren's ceiling ended at ${fmt(this.sb.ship.ceiling)} marks per cured fish.`,
      ...this.milestones.slice(0, 4),
      'No patch, no tweaks: every change came from merchants reacting to stock and demand.',
    ];
  }
}
