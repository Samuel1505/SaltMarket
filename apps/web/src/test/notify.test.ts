import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ text: string; id?: string | number }> = [];
let next = 0;
vi.mock('sonner', () => {
  const t = (text: string, o?: { id?: string | number }) => {
    calls.push({ text, ...(o?.id !== undefined ? { id: o.id } : {}) });
    return o?.id ?? ++next;
  };
  t.error = t;
  return { toast: t };
});
vi.stubGlobal('performance', { now: () => clock });
let clock = 0;

describe('notify', () => {
  beforeEach(() => {
    calls.length = 0;
    clock += 100_000; // fresh window per test
    vi.resetModules();
  });

  it('collapses identical messages into one toast with ×N', async () => {
    const { notify } = await import('../lib/notify');
    notify('+2 fish');
    clock += 500;
    notify('+2 fish');
    clock += 500;
    notify('+2 fish');
    expect(calls.map((c) => c.text)).toEqual(['+2 fish', '+2 fish ×2', '+2 fish ×3']);
    expect(calls[1]?.id).toBe(calls[2]?.id);
  });

  it('rate-limits town news but never the player’s own results', async () => {
    const { notify } = await import('../lib/notify');
    for (let i = 0; i < 20; i++) notify(`Town news ${i}`, { town: true });
    for (let i = 0; i < 5; i++) notify(`Sold ${i} fish`);
    expect(calls.filter((c) => c.text.startsWith('Town news'))).toHaveLength(3);
    expect(calls.filter((c) => c.text.startsWith('Sold'))).toHaveLength(5);
  });
});
