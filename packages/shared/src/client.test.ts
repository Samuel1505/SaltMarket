import { describe, expect, it } from 'vitest';
import { applyDelta, applyFeed, cmd, formatBps, formatMarks, gatherReadyIn, npcAction, offersFor, shipTimers } from './client.js';
import { ClientMessage, type FeedItem, type WorldSnapshot } from './protocol.js';

const clock = { tick: 100, day: 4, hour: 4, realMsPerTick: 2500, speed: 1, paused: false };
const offer = (id: string, side: 'buy' | 'sell', pricePips: number) => ({ id, venueId: 'harbor', good: 'fish' as const, side, pricePips, qty: 5, owner: { kind: 'npc' as const, id: 'x', name: 'X', isMe: false }, createdTick: 1 });
const world = {
  clock, me: { gather: { readyAtTick: 104, gatheredToday: 0, dailyCap: 12 } }, ship: { ticksToArrival: 8, ticksToDeparture: 0 },
  venues: [{ id: 'harbor' }], quotes: [{ venueId: 'harbor', good: 'fish', lastPips: 900 }, { venueId: 'harbor', good: 'salt', lastPips: 600 }],
  npcs: [{ id: 'a', status: 'open' }, { id: 'b', status: 'closed' }], nodes: [{ id: 'pier', stock: 30 }],
  offers: [offer('o1', 'buy', 900), offer('o2', 'buy', 950), offer('o3', 'sell', 1100)], events: [], feed: [], town: {},
} as unknown as WorldSnapshot;

describe('client helpers', () => {
  it('applyDelta: replaces, upserts by key, deletes removed offers, keeps untouched identities', () => {
    const next = applyDelta(world, { clock: { ...clock, tick: 101 }, quotes: [{ venueId: 'harbor', good: 'fish', lastPips: 1000 } as never], removedOfferIds: ['o1'], offers: [offer('o4', 'sell', 1050)] });
    expect(next.clock.tick).toBe(101);
    expect(next.quotes.find((q) => q.good === 'fish')?.lastPips).toBe(1000);
    expect(next.quotes).toHaveLength(2);
    expect(next.offers.map((o) => o.id).sort()).toEqual(['o2', 'o3', 'o4']);
    expect(next.npcs).toBe(world.npcs);
    expect(next.me).toBe(world.me);
    expect(applyDelta(world, { clock, me: null }).me).toBeNull();
  });
  it('applyFeed: newest first, dedupe by id, cap', () => {
    const f = (id: string, tick: number, repeat = 1) => ({ id, tick, repeat }) as FeedItem;
    expect(applyFeed([f('a', 1), f('b', 2)], [f('b', 2, 3), f('c', 3)]).map((x) => `${x.id}${x.repeat}`)).toEqual(['c1', 'b3', 'a1']);
    expect(applyFeed([], Array.from({ length: 150 }, (_, i) => f(`x${i}`, i)))).toHaveLength(100);
  });
  it('formatting', () => {
    expect([formatMarks(1050), formatMarks(1000), formatMarks(1234), formatMarks(123456789), formatMarks(-50)]).toEqual(['10.5', '10', '12.34', '1,234,567.89', '-0.5']);
    expect([formatBps(250), formatBps(100), formatBps(0)]).toEqual(['2.5%', '1%', '0%']);
  });
  it('timers, offers, invest action, cmd builder', () => {
    expect(gatherReadyIn(world)).toBe(10);
    expect(shipTimers(world)).toEqual({ arrivesIn: 20, leavesIn: 0 });
    expect(offersFor(world, 'harbor', 'fish', 'buy').map((o) => o.id)).toEqual(['o2', 'o1']);
    expect(npcAction({ status: 'closed' } as never)).toBe('invest');
    expect(npcAction({ status: 'closed', investor: {} } as never)).toBe('none');
    expect(ClientMessage.parse(cmd({ t: 'gather', node: 'pier' })).t).toBe('gather');
  });
});
