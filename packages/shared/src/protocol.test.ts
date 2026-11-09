import { describe, expect, it } from 'vitest';
import { ECONOMY } from './config/economy.js';
import {
  ClientMessage,
  ExplainResponse,
  PROTOCOL_VERSION,
  ServerMessage,
  WorldResponse,
  WorldSnapshot,
  type NpcCard,
  type WorldSnapshot as WorldSnapshotT,
} from './protocol.js';

const reasoning = { code: 'LOW_STOCK_RAISE_ASK', text: 'Salt is scarce, raising my price 12%.', factors: [{ key: 'stock', label: 'Stock', value: 3, unit: 'count' as const, of: 14 }], tick: 30 };

const npc: NpcCard = {
  id: 'salt-1', name: 'Hester', title: 'Salt-panner', bio: 'Rakes the pans at dawn.', archetype: 'salt_panner',
  status: 'closed', purse: { pips: 120, trend: 'down' }, inventory: { salt: 3 }, sells: ['salt'], buys: [],
  reasoning, recent: [{ tick: 30, reasoning, repeat: 1 }],
  closed: { sinceTick: 28, investMinPips: 15000, investMaxPips: 60000, rescueInTicks: 118 },
};

const world: WorldSnapshotT = {
  protocolVersion: PROTOCOL_VERSION, serverMode: 'mock',
  clock: { tick: 30, day: 1, hour: 6, realMsPerTick: 2500, speed: 1, paused: false },
  catalog: {
    goods: [{ id: 'fish', name: 'Fish', anchorPips: 1000, spoilsPerDayBps: 400 }],
    recipes: [{ id: 'cure_fish', name: 'Cure fish', inputs: { fish: 6, salt: 3, barrel: 1 }, outputs: { cured_fish: 4 }, ticks: 6 }],
    ticksPerDay: 24, harborTaxBps: 200, hallFeeMaxBps: 500, hallLicensePips: 40000, stallRentPerDayPips: 1500,
    investMinPips: 15000, investMaxPips: 60000, gatherCooldownTicks: 4, gatherDailyCap: 12,
  },
  me: null,
  venues: [{ id: 'harbor', kind: 'harbor', name: 'Harbor Market', ownerIsMe: false, feeBps: 0, taxBps: 200, frictionBps: 150, volume24hPips: 0, feeIncome24hPips: 0, feeIncomeTotalPips: 0 }],
  quotes: [{ venueId: 'harbor', good: 'fish', bestBidPips: 900, bestBidQty: 6, bestAskPips: 1100, bestAskQty: 10, lastPips: 1000, median2dPips: 1000, change24hBps: 1200, trend: 'up', volume24h: 14 }],
  offers: [], nodes: [{ id: 'pier', name: 'Pier', good: 'fish', stock: 30, cap: 40, regenPerDay: 20, yieldNow: 2, gatherers24h: 1 }],
  npcs: [npc],
  ship: { captainNpcId: 'captain', name: 'the Gull', status: 'away', ticksToArrival: 18, ticksToDeparture: 0, ceilingPips: 6000, volume: 16, filled: 0 },
  events: [], feed: [{ id: 'f1', tick: 28, kind: 'MERCHANT_CLOSED', text: 'Hester closed her pans.', notable: true, mine: false, npcId: 'salt-1', repeat: 1 }],
  town: { marksSupplyPips: 500000, townFundPips: 1000, volume24hPips: 20000, openMerchants: 8, closedMerchants: 1 },
};

describe('protocol', () => {
  it('parses a world snapshot and its REST envelope', () => {
    expect(WorldSnapshot.parse(world).npcs[0]?.status).toBe('closed');
    expect(WorldResponse.parse({ ok: true, data: world }).ok).toBe(true);
    expect(WorldResponse.parse({ ok: false, code: 'UNAUTHORIZED', message: 'Please sign in.' }).ok).toBe(false);
  });

  it('validates client messages strictly by type', () => {
    expect(ClientMessage.parse({ t: 'gather', cmdId: 'c1', node: 'pier' }).t).toBe('gather');
    expect(ClientMessage.safeParse({ t: 'gather', cmdId: 'c1', node: 'moon' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'sell', cmdId: 'c2', good: 'fish', qty: 0, venueId: 'harbor' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'teleport', cmdId: 'c3' }).success).toBe(false);
  });

  it('parses server messages, tolerating unknown fields and open-ended codes', () => {
    const ack = ServerMessage.parse({ t: 'ack', cmdId: 'c1', ok: false, code: 'SOME_FUTURE_CODE', message: 'Nope.', extra: 1 });
    expect(ack).not.toHaveProperty('extra');
    expect(ServerMessage.parse({ t: 'delta', tick: 31, changes: { clock: { ...world.clock, tick: 31 }, npcs: [npc] } }).t).toBe('delta');
    expect(ServerMessage.parse({ t: 'ack', cmdId: 'c9', ok: true, message: '+2 fish', result: { kind: 'gathered', node: 'pier', good: 'fish', qty: 2, readyAtTick: 34 } }).t).toBe('ack');
  });

  it('parses an explain payload', () => {
    const r = ExplainResponse.parse({ ok: true, data: { npcId: 'salt-1', name: 'Hester', status: 'open', reasoning, prices: [{ good: 'salt', side: 'sell', pricePips: 720, reasoning }], rulesFile: 'packages/sim/src/pricing/merchant-rules.ts' } });
    expect(r.ok).toBe(true);
  });

  it('keeps money in integer pips', () => {
    expect(WorldSnapshot.safeParse({ ...world, town: { ...world.town, townFundPips: 10.5 } }).success).toBe(false);
    expect(ECONOMY.currency.pipsPerMark).toBe(100);
  });
});
