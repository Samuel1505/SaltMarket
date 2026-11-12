// break-ui fixtures (dev only, `?data=worst` or `?data=empty`). They change the data at the store boundary, never
// the components. Values are realistic or schema limits (displayName ≤ 24, hall name ≤ 40), not random noise.
import type { Leaderboard, WorldSnapshot } from '@saltmarket/shared/protocol';

export type DevData = 'worst' | 'empty' | null;

export const DEV_DATA: DevData = (() => {
  if (!import.meta.env.DEV) return null;
  try {
    const v = new URLSearchParams(location.search).get('data');
    return v === 'worst' || v === 'empty' ? v : null;
  } catch {
    return null;
  }
})();

const LONG_PLAYER = 'Aleksandra Wiśniewska-Ko'; // 24 chars: the LoginRequest max
const LONG_HALL = 'The Northwind Industries Holdings Exchan'; // 40 chars: the buyHall max
const LONG_NPC = "Old Pell's Smokehouse & Curing Company";

export function worstWorld(w: WorldSnapshot): WorldSnapshot {
  const big = 123_456_789; // 1,234,567.89 marks
  return {
    ...w,
    me: w.me && {
      ...w.me,
      displayName: LONG_PLAYER,
      marksPips: big,
      netWorthPips: big * 3,
      inventory: { fish: 1284, salt: 1, timber: 0, barrel: 37, cured_fish: 9999 },
      investments: [
        { npcId: 'cooper', npcName: LONG_NPC, principalPips: 60_000, paidOutPips: 74_999, capPips: 75_000, active: true },
        { npcId: 'salt-2', npcName: 'Jo', principalPips: 15_000, paidOutPips: 18_750, capPips: 18_750, active: false },
      ],
    },
    ship: { ...w.ship, ceilingPips: 1_234_567, volume: 1284, filled: 1283 },
    quotes: w.quotes.map((q, i) => ({ ...q, bestBidPips: i === 0 ? 1_234_567 : q.bestBidPips, change24hBps: i === 0 ? 12_345 : q.change24hBps, trend: i === 0 ? 'up' : q.trend, trendReason: i === 0 ? 'Fish ▲ 123%: the storm cut the catch and the ship is in harbor' : q.trendReason })),
    offers: w.offers.map((o, i) => (i < 3 ? { ...o, pricePips: 1_234_567, owner: { ...o.owner, name: LONG_NPC } } : o)),
    npcs: w.npcs.map((n, i) =>
      i === 0
        ? { ...n, name: LONG_NPC, title: 'Smokehouse and cured-fish wholesaler', purse: { pips: 987_654_321, trend: 'up' } }
        : i === 1
          ? { ...n, name: 'Jo', status: 'closed', purse: { pips: 0, trend: 'down' }, closed: { sinceTick: w.clock.tick, investMinPips: 15_000, investMaxPips: 60_000, rescueInTicks: 120 } }
          : n,
    ),
    venues: [
      ...w.venues.filter((v) => v.id !== 'hall-dev'),
      { id: 'hall-dev', kind: 'hall', name: LONG_HALL, ownerName: LONG_PLAYER, ownerIsMe: true, feeBps: 500, taxBps: 200, frictionBps: 0, volume24hPips: big * 10, feeIncome24hPips: big, feeIncomeTotalPips: big * 4 },
    ],
    feed: Array.from({ length: 30 }, (_, i) => ({
      id: `dev-${i}`,
      tick: w.clock.tick - i,
      kind: i % 3 === 0 ? 'MERCHANT_CLOSED' : 'npc_decision',
      text: `${LONG_NPC}: bartholomew.fitzgerald@northwind-industries-holdings.example.com bought 1,284 cured fish for 1,234,567.89 marks`,
      notable: i % 3 === 0,
      mine: i % 5 === 0,
      repeat: i === 1 ? 37 : 1,
    })),
  };
}

export function emptyWorld(w: WorldSnapshot): WorldSnapshot {
  return {
    ...w,
    me: w.me && { ...w.me, marksPips: 0, inventory: { fish: 0, salt: 0, timber: 0, barrel: 0, cured_fish: 0 }, investments: [], hallIds: [] },
    npcs: [],
    offers: [],
    feed: [],
    venues: w.venues.filter((v) => v.kind === 'harbor'),
    quotes: w.quotes.map((q) => ({ ...q, bestBidPips: null, bestAskPips: null, lastPips: null, trend: 'flat', change24hBps: 0, trendReason: undefined })),
  };
}

export function devWorld(w: WorldSnapshot): WorldSnapshot {
  return DEV_DATA === 'worst' ? worstWorld(w) : DEV_DATA === 'empty' ? emptyWorld(w) : w;
}

export function devBoard(b: Leaderboard): Leaderboard {
  if (DEV_DATA === 'empty') return { ...b, netWorth: [], hallIncome: [] };
  if (DEV_DATA !== 'worst') return b;
  const rows = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, playerId: `p${i}`, displayName: i === 0 ? LONG_PLAYER : `Trader ${i + 1}`, isMe: i === 36, valuePips: 987_654_321 - i * 1_000_000 }));
  return { ...b, netWorth: rows, hallIncome: rows.slice(0, 50) };
}
