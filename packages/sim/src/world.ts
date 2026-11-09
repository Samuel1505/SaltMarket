// Fresh world and new players. Starting marks are the logged genesis (ECONOMY §4).
import { ECONOMY, GATHER_NODES, GOODS, ROSTER, type Good } from '@saltmarket/shared/config';
import { createGood, emptyInv, mint } from './ledger.js';
import { CAPTAIN, HARBOR, TOWN_FUND, type Account, type Npc, type WorldState } from './types.js';

const E = ECONOMY;
const goodsRecord = <T>(f: (g: Good) => T) => Object.fromEntries(GOODS.map((g) => [g, f(g)])) as Record<Good, T>;

export function createWorld(seed: number): WorldState {
  const s: WorldState = {
    version: 1, seed, rngState: seed >>> 0, tick: 0, seq: 0,
    accounts: {}, players: {}, npcs: {}, orders: {}, halls: {},
    nodes: Object.fromEntries(GATHER_NODES.map((n) => [n, E.gather.nodes[n].cap])) as WorldState['nodes'],
    ship: { visit: 0, docked: false, arrivalTick: E.captain.firstArrivalTick, departureTick: E.captain.firstArrivalTick + E.captain.dockTicks, volume: E.captain.volume, baseVolume: E.captain.volume, filled: 0, smokehouseSold: 0, filledAtTick: null, ceiling: E.captain.startCeiling, reason: { code: "STEADY", text: "Sailing for Saltmarket. I pay up to 50 marks a cured fish.", factors: [], tick: 0 } },
    events: [],
    supply: { genesis: 0, minted: 0, burned: 0 },
    goods: { initial: emptyInv(), created: emptyInv(), destroyed: emptyInv() },
    trades: [],
    history: goodsRecord(() => []),
    daily: [],
    listedEma: goodsRecord(() => 0),
  };
  const open = (id: string, kind: Account['kind'], name: string, marks: number, inv: Partial<Record<Good, number>>) => {
    s.accounts[id] = { id, kind, name, marks, inv: { ...emptyInv(), ...inv } };
    s.supply.genesis += marks;
    for (const g of GOODS) s.goods.initial[g] += inv[g] ?? 0;
  };
  open(TOWN_FUND, 'townfund', 'Town Fund', E.townFund.startBalance, {});
  for (const r of ROSTER) {
    if (r.archetype === 'captain') { open(CAPTAIN, 'captain', r.name, 0, {}); continue; }
    const cfg = E.npcs[r.archetype];
    open(r.id, 'npc', r.name, cfg.startCash, cfg.startInventory);
    const npc: Npc = {
      id: r.id, archetype: r.archetype, status: 'open', brokeDays: 0, closedSince: null, rescueAt: null, investor: null,
      jobs: [], prodCarry: 0, prodPaused: false, lowPriceDays: 0, dayStartMarks: cfg.startCash, spentToday: 0,
      lastPrice: {}, venueId: HARBOR,
      reasoning: { code: 'STEADY', text: 'Opening up for the day.', factors: [], tick: 0 }, recent: [],
    };
    s.npcs[r.id] = npc;
  }
  return s;
}

/** Open a player's stall: starting marks are a logged grant (mint), the kit is created goods. */
export function addPlayer(s: WorldState, id: string, name: string): void {
  if (s.accounts[id]) return;
  s.accounts[id] = { id, kind: 'player', name, marks: 0, inv: emptyInv() };
  mint(s, id, E.player.startMarks);
  for (const g of GOODS) createGood(s, id, g, E.player.startInventory[g]);
  s.players[id] = { id, joinedTick: s.tick, readyAt: s.tick, gatheredToday: 0, jobs: [], level: 1, arrears: 0, lastHarborBuyTick: -1, pairTrades: {} };
}

/** Demo/test seeding only: grant marks to an account (a logged mint, so conservation still holds). */
export function grantMarks(s: WorldState, id: string, pips: number): void {
  mint(s, id, pips);
}
