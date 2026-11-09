import { describe, expect, it } from 'vitest';
import { closureScenario, floodScenario, hallScenario, stormScenario } from './scenarios.js';

describe('scenarios (TESTING_AND_DEMO §3–4)', () => {
  for (const [name, run] of [['storm', () => stormScenario(42)], ['flood', () => floodScenario(42)], ['hall competition', () => hallScenario(42)], ['closure', () => closureScenario(42)]] as const) {
    it(name, () => {
      const r = run();
      const failed = r.checks.filter((c) => !c.ok).map((c) => c.text);
      expect(failed, `${r.name}\n${r.table.join('\n')}`).toEqual([]);
    });
  }
  it('storm price, reasoning, Smokehouse and recovery hold across seeds', () => {
    // The Captain's short visit depends on where the storm lands in the 2-day ship cycle, so it is
    // asserted for the seed-42 demo run above and reported (not asserted) for other seeds.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const failed = stormScenario(seed).checks.filter((c) => !c.ok && !c.text.includes('ship visit goes short')).map((c) => c.text);
      expect(failed, `seed ${seed}`).toEqual([]);
    }
  });
});
