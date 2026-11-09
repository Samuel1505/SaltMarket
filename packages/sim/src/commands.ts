// Player commands: validated against the world, applied immediately, returning a typed result
// (never throwing for expected failures; CLAUDE.md §9). Messages are friendly, player-facing text.
import { ECONOMY, GOOD_NAMES, NODE_NAMES, RECIPE_NAMES, type GatherNodeKey, type Good, type RecipeKey } from '@saltmarket/shared/config';
import type { AckResult } from '@saltmarket/shared/protocol';
import { burn, createGood, destroyGood, nextId, transfer } from './ledger.js';
import { buyHallLicense, cancelOrder, hitBids, placeOrder, takeAsks, venueExists } from './market.js';
import { fmt } from './pricing/merchant-rules.js';
import { npcName, reopenNpc } from './events.js';
import { CAPTAIN, HARBOR, type Player, type SimEvent, type WorldState } from './types.js';

const E = ECONOMY;
const lc = (g: Good) => GOOD_NAMES[g].toLowerCase();

export type Command =
  | { t: 'gather'; node: GatherNodeKey }
  | { t: 'sell'; good: Good; qty: number; venueId: string; minPricePips?: number | undefined }
  | { t: 'buy'; good: Good; qty: number; venueId: string; maxPricePips?: number | undefined }
  | { t: 'list'; good: Good; qty: number; pricePips: number; venueId: string }
  | { t: 'bid'; good: Good; qty: number; pricePips: number; venueId: string }
  | { t: 'cancel'; orderId: string }
  | { t: 'craft'; recipe: RecipeKey }
  | { t: 'upgradeStall' }
  | { t: 'buyHall'; name?: string | undefined }
  | { t: 'setHallFee'; hallId: string; bps: number }
  | { t: 'invest'; npcId: string; amountPips: number };

export type CommandResult = { ok: boolean; code?: string; message: string; result?: AckResult };

const no = (code: string, message: string): CommandResult => ({ ok: false, code, message });
const yes = (message: string, result: AckResult): CommandResult => ({ ok: true, message, result });
const names = (s: WorldState, ids: string[]) => ids.map((id) => (id === CAPTAIN ? 'Captain Maren' : s.accounts[id]?.name ?? id));

export function isShuttered(s: WorldState, p: Player): boolean {
  return p.arrears > 0 && s.tick - p.joinedTick > (E.player.rentGraceDays + E.player.shutterAfterBrokeDays) * E.time.ticksPerDay;
}

export function yieldFor(s: WorldState, node: GatherNodeKey): number {
  const frac = s.nodes[node] / E.gather.nodes[node].cap;
  const y = E.gather.yieldTiers;
  return frac >= y.fullAtOrAbove ? y.fullYield : frac >= y.partialAtOrAbove ? y.partialYield : 0;
}

export function applyCommand(s: WorldState, playerId: string, c: Command, ev: SimEvent[]): CommandResult {
  const p = s.players[playerId];
  const acc = s.accounts[playerId];
  if (!p || !acc) return no('UNAUTHORIZED', 'Please sign in to trade.');
  if (isShuttered(s, p) && ['buy', 'sell', 'list', 'bid', 'craft'].includes(c.t)) return no('STALL_SHUTTERED', 'Your stall is shuttered until you pay the rent you owe.');

  switch (c.t) {
    case 'gather': {
      if (s.tick < p.readyAt) return no('COOLDOWN', `You're still catching your breath. Ready again in ${Math.ceil(((p.readyAt - s.tick) * E.time.realMsPerTick) / 1000)} s.`);
      if (p.gatheredToday >= E.gather.perPlayerPerDay) return no('DAILY_CAP', `You've gathered ${E.gather.perPlayerPerDay} today. Come back tomorrow.`);
      const y = yieldFor(s, c.node);
      if (y === 0) return no('NODE_DEPLETED', `The ${NODE_NAMES[c.node].toLowerCase()} is picked clean. It refills overnight.`);
      const good = E.gather.nodes[c.node].good;
      const qty = Math.min(y, E.gather.perPlayerPerDay - p.gatheredToday, s.nodes[c.node]);
      s.nodes[c.node] -= qty;
      createGood(s, playerId, good, qty);
      p.gatheredToday += qty;
      p.readyAt = s.tick + E.gather.cooldownTicks;
      return yes(`+${qty} ${lc(good)}`, { kind: 'gathered', node: c.node, good, qty, readyAtTick: p.readyAt });
    }

    case 'sell': {
      if (!venueExists(s, c.venueId)) return no('NOT_FOUND', 'No such market.');
      if (acc.inv[c.good] < c.qty) return no('INSUFFICIENT_GOODS', `Not enough ${lc(c.good)}: you have ${acc.inv[c.good]}, you tried to sell ${c.qty}.`);
      const r = hitBids(s, playerId, c.venueId, c.good, c.qty, c.minPricePips ?? 1);
      if (r.qty === 0) return no('NO_BUYER', `Nobody here is buying ${lc(c.good)}${c.minPricePips ? ` at ${fmt(c.minPricePips)} marks or more` : ' right now'}.`);
      const net = r.gross - r.tax - r.fee;
      const who = names(s, r.counterparties);
      const text = `Sold ${r.qty} ${lc(c.good)} to ${who.join(', ')} for ${fmt(net)} marks`;
      ev.push({ kind: 'trade', text, notable: false, accountId: playerId, good: c.good });
      return yes(text, { kind: 'trade', side: 'sell', good: c.good, qty: r.qty, avgPricePips: Math.round(r.gross / r.qty), totalPips: net, taxPips: r.tax, feePips: r.fee, counterparties: who });
    }

    case 'buy': {
      if (!venueExists(s, c.venueId)) return no('NOT_FOUND', 'No such market.');
      if (c.venueId === HARBOR && p.lastHarborBuyTick === s.tick) return no('RATE_LIMITED', 'The Harbor Market allows one purchase per hour. Wait a moment, or trade in a Hall.');
      const r = takeAsks(s, playerId, c.venueId, c.good, c.qty, c.maxPricePips ?? Number.MAX_SAFE_INTEGER, acc.marks);
      if (r.qty === 0) {
        const any = Object.values(s.orders).some((o) => o.venueId === c.venueId && o.good === c.good && o.side === 'sell' && o.owner !== playerId);
        return any ? no('INSUFFICIENT_FUNDS', `Not enough marks for ${lc(c.good)} at that price. You have ${fmt(acc.marks)}.`) : no('NO_SELLER', `Nobody here is selling ${lc(c.good)} right now.`);
      }
      if (c.venueId === HARBOR) p.lastHarborBuyTick = s.tick;
      const who = names(s, r.counterparties);
      const text = `Bought ${r.qty} ${lc(c.good)} from ${who.join(', ')} for ${fmt(r.gross)} marks`;
      ev.push({ kind: 'trade', text, notable: false, accountId: playerId, good: c.good });
      return yes(text, { kind: 'trade', side: 'buy', good: c.good, qty: r.qty, avgPricePips: Math.round(r.gross / r.qty), totalPips: r.gross, taxPips: 0, feePips: 0, counterparties: who });
    }

    case 'list': {
      if (!venueExists(s, c.venueId)) return no('NOT_FOUND', 'No such market.');
      if (acc.inv[c.good] < c.qty) return no('INSUFFICIENT_GOODS', `Not enough ${lc(c.good)}: you have ${acc.inv[c.good]}, you tried to list ${c.qty}.`);
      const o = placeOrder(s, { owner: playerId, venueId: c.venueId, good: c.good, side: 'sell', price: c.pricePips, qty: c.qty });
      return yes(`Listed ${c.qty} ${lc(c.good)} at ${fmt(c.pricePips)} marks each`, { kind: 'listed', orderId: o?.id ?? 'filled', good: c.good, qty: c.qty, pricePips: c.pricePips });
    }

    case 'bid': {
      if (!venueExists(s, c.venueId)) return no('NOT_FOUND', 'No such market.');
      if (c.venueId === HARBOR) return no('BAD_REQUEST', 'The Harbor Market takes no standing buy offers. Post one in a Hall.');
      if (acc.marks < c.qty * c.pricePips) return no('INSUFFICIENT_FUNDS', `Not enough marks: this offer needs ${fmt(c.qty * c.pricePips)} and you have ${fmt(acc.marks)}.`);
      const o = placeOrder(s, { owner: playerId, venueId: c.venueId, good: c.good, side: 'buy', price: c.pricePips, qty: c.qty });
      return yes(`Offered to buy ${c.qty} ${lc(c.good)} at ${fmt(c.pricePips)} marks each`, { kind: 'listed', orderId: o?.id ?? 'filled', good: c.good, qty: c.qty, pricePips: c.pricePips });
    }

    case 'cancel': {
      const o = s.orders[c.orderId];
      if (!o || o.owner !== playerId) return no('NOT_FOUND', 'That offer is already gone.');
      cancelOrder(s, o.id);
      return yes('Offer withdrawn', { kind: 'cancelled', orderId: o.id });
    }

    case 'craft': {
      if (p.jobs.length >= p.level) return no('CRAFT_BUSY', 'Your workbench is busy. Wait for the current batch or upgrade your stall.');
      const r = E.recipes[c.recipe];
      for (const [g, q] of Object.entries(r.in) as [Good, number][]) if (acc.inv[g] < q) return no('INSUFFICIENT_GOODS', `Not enough ${lc(g)}: you need ${q}, you have ${acc.inv[g]}.`);
      for (const [g, q] of Object.entries(r.in) as [Good, number][]) destroyGood(s, playerId, g, q);
      const job = { id: nextId(s, 'j'), recipe: c.recipe, started: s.tick, done: s.tick + r.ticks };
      p.jobs.push(job);
      return yes(`${RECIPE_NAMES[c.recipe]}: ready in ${Math.round((r.ticks * E.time.realMsPerTick) / 1000)} s`, { kind: 'craft_started', job: { id: job.id, recipe: job.recipe, startedTick: job.started, doneTick: job.done } });
    }

    case 'upgradeStall': {
      if (p.level >= E.stall.maxLevel) return no('MAX_UPGRADE', 'Your stall is already as big as the harbor allows.');
      if (acc.marks < E.stall.upgradeCost) return no('INSUFFICIENT_FUNDS', `An upgrade costs ${fmt(E.stall.upgradeCost)} marks; you have ${fmt(acc.marks)}.`);
      burn(s, playerId, E.stall.upgradeCost);
      p.level += 1;
      return yes('Stall upgraded: a second workbench is ready.', { kind: 'stall_upgraded', level: p.level });
    }

    case 'buyHall': {
      if (Object.values(s.halls).some((h) => h.ownerId === playerId)) return no('BAD_REQUEST', 'You already own an Exchange Hall.');
      if (acc.marks < E.sinks.hallLicense) return no('INSUFFICIENT_FUNDS', `A Hall license costs ${fmt(E.sinks.hallLicense)} marks; you have ${fmt(acc.marks)}.`);
      buyHallLicense(s, playerId);
      const id = `hall-${Object.keys(s.halls).length + 1}`;
      const name = c.name ?? `${acc.name}'s Exchange`;
      s.halls[id] = { id, name, ownerId: playerId, feeBps: 200, nextFeeBps: 200, feeIncomeTotal: 0 };
      ev.push({ kind: 'hall_licensed', text: `${acc.name} opened ${name}, charging a 2% fee.`, notable: true, accountId: playerId });
      return yes(`You own ${name}. Set your fee to attract traders.`, { kind: 'hall_bought', hallId: id });
    }

    case 'setHallFee': {
      const h = s.halls[c.hallId];
      if (!h) return no('NOT_FOUND', 'No such Hall.');
      if (h.ownerId !== playerId) return no('NOT_HALL_OWNER', 'Only the owner can set this Hall’s fee.');
      if (c.bps < 0 || c.bps > E.fees.hallFeeMaxBps) return no('FEE_OUT_OF_RANGE', `Fees must be between 0% and ${E.fees.hallFeeMaxBps / 100}%.`);
      h.nextFeeBps = c.bps; // applies from the next tick (ECONOMY §6.2)
      ev.push({ kind: 'hall_fee_changed', text: `${h.name} now charges ${c.bps / 100}%.`, notable: false, accountId: playerId });
      return yes(`Fee set to ${c.bps / 100}% from the next hour.`, { kind: 'hall_fee_set', hallId: h.id, bps: c.bps });
    }

    case 'invest': {
      const npc = s.npcs[c.npcId];
      if (!npc) return no('NOT_FOUND', 'No merchant by that name in town.');
      if (npc.status !== 'closed') return no('MERCHANT_OPEN', `${npcName(npc.id)} is open for business and doesn't need backing.`);
      if (npc.investor) return no('MERCHANT_HAS_INVESTOR', `${npcName(npc.id)} already has a backer.`);
      const { investMin, investMax } = E.merchants;
      if (c.amountPips < investMin || c.amountPips > investMax) return no('INVEST_OUT_OF_RANGE', `Invest between ${fmt(investMin)} and ${fmt(investMax)} marks.`);
      if (acc.marks < c.amountPips) return no('INSUFFICIENT_FUNDS', `You have ${fmt(acc.marks)} marks.`);
      transfer(s, playerId, npc.id, c.amountPips);
      const cap = Math.round((c.amountPips * E.merchants.payoutCapBps) / 10000);
      npc.investor = { playerId, principal: c.amountPips, paidOut: 0, cap };
      reopenNpc(s, npc, { code: 'INVESTMENT_RECEIVED_REOPEN', text: `${acc.name} backed me with ${fmt(c.amountPips)} marks. Back in business.`, factors: [], tick: s.tick }, ev);
      ev.push({ kind: 'MERCHANT_REOPENED', text: `${npcName(npc.id)} reopened, backed by ${acc.name}.`, notable: true, accountId: playerId, npcId: npc.id });
      return yes(`You backed ${npcName(npc.id)} with ${fmt(c.amountPips)} marks. You'll get 25% of daily profit until you've received ${fmt(cap)}.`, { kind: 'invested', npcId: npc.id, amountPips: c.amountPips });
    }
  }
}
