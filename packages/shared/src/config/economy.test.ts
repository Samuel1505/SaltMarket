import { describe, expect, it } from 'vitest';
import { ECONOMY, GOODS } from './economy.js';

describe('economy config', () => {
  it('stores money as integer pips', () => {
    for (const g of GOODS) expect(Number.isInteger(ECONOMY.goods[g].anchor)).toBe(true);
    expect(ECONOMY.player.startMarks).toBe(30000);
  });
  it('reflects the approved loop (2026-11-09)', () => {
    expect(ECONOMY.gather.cooldownTicks * ECONOMY.time.realMsPerTick).toBe(10_000);
    expect(ECONOMY.captain.firstArrivalTick * ECONOMY.time.realMsPerTick).toBe(50_000);
    expect(ECONOMY.npcs.smokehouse.maxCuredSellPerVisit).toBe(ECONOMY.captain.volume / 2);
  });
});
