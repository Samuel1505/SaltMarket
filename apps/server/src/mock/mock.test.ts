import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerMessage, WorldSnapshot, WorldDelta, type ServerMessage as SM } from '@saltmarket/shared/protocol';
import { buildApp } from '../app.js';
import { MockBackend } from './mockBackend.js';

describe('mock backend stays protocol-valid', () => {
  it('runs 400 ticks with valid snapshots, deltas and the scripted story', () => {
    const b = new MockBackend({ timelapseFrameMs: 1 });
    const s = b.login('guest', 'Tester');
    if (!s.ok) throw new Error('login');
    const pid = s.data.playerId;
    const kinds = new Set<string>();
    let docked = false;
    expect(b.snapshot(pid).npcs.some((n) => n.status === 'closed')).toBe(true);
    for (let i = 0; i < 400; i++) {
      b.step();
      WorldDelta.parse(b.deltaFor(pid));
      for (const f of b.feedFor(pid)) kinds.add(f.kind);
      if (b.snapshot(null).ship.status === 'docked') docked = true;
      if (i % 50 === 0) WorldSnapshot.parse(b.snapshot(pid));
    }
    expect(docked).toBe(true);
    for (const k of ['event_start', 'ship_docked', 'ship_departed', 'MERCHANT_RESCUED', 'npc_decision']) expect(kinds).toContain(k);
  });

  it('gives plausible acks: gather ok, then cooldown; sell; bad invest', () => {
    const b = new MockBackend();
    const s = b.login('guest');
    if (!s.ok) throw new Error('login');
    const pid = s.data.playerId;
    expect(b.command(pid, { t: 'gather', cmdId: '1', node: 'pier' }).ok).toBe(true);
    expect(b.command(pid, { t: 'gather', cmdId: '2', node: 'pier' }).code).toBe('COOLDOWN');
    const sold = b.command(pid, { t: 'sell', cmdId: '3', good: 'fish', qty: 2, venueId: 'harbor' });
    expect(sold.ok).toBe(true);
    expect(b.command(pid, { t: 'sell', cmdId: '4', good: 'cured_fish', qty: 1, venueId: 'harbor' }).code).toBe('INSUFFICIENT_GOODS');
    expect(b.command(pid, { t: 'invest', cmdId: '5', npcId: 'fisher-1', amountPips: 20000 }).code).toBe('MERCHANT_OPEN');
    expect(b.command(pid, { t: 'invest', cmdId: '6', npcId: 'salt-2', amountPips: 20000 }).ok).toBe(true);
  });
});

describe('transport', () => {
  const backend = new MockBackend({ timelapseFrameMs: 2 });
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let url = '';
  beforeAll(async () => {
    ctx = await buildApp(backend, { judge: true, autoTick: false, validateOutgoing: 'throw' });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = ctx.app.server.address();
    url = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  });
  afterAll(() => ctx.app.close());

  it('serves REST in the fixed envelope', async () => {
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { provider: 'guest' } });
    expect(login.json().ok).toBe(true);
    expect((await ctx.app.inject({ url: '/api/world' })).json().ok).toBe(true);
    expect((await ctx.app.inject({ url: '/api/npcs/nobody/explain' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/api/market/fish/history?days=5' })).json().data.points.length).toBeGreaterThan(10);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/dev/event', payload: { kind: 'storm' } })).json().ok).toBe(true);
    expect((await ctx.app.inject({ url: '/api/judge/ledger' })).json().data.mode).toBe('memory');
  });

  it('speaks the WS protocol: hello, snapshot, ack, delta, timelapse', async () => {
    const login = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { displayName: 'Ws' } })).json();
    const ws = new WebSocket(`ws://${url}/ws?token=${login.data.token}`);
    const got: SM[] = [];
    ws.onmessage = (e) => got.push(ServerMessage.parse(JSON.parse(String(e.data))));
    await new Promise((r) => (ws.onopen = r));
    const wait = async (pred: (m: SM) => boolean) => {
      for (let i = 0; i < 200; i++) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
      throw new Error('timeout');
    };
    await wait((m) => m.t === 'snapshot');
    ws.send(JSON.stringify({ t: 'gather', cmdId: 'g1', node: 'grove' }));
    expect(await wait((m) => m.t === 'ack' && m.cmdId === 'g1')).toMatchObject({ ok: true });
    ws.send(JSON.stringify({ t: 'fly', cmdId: 'x1' }));
    expect(await wait((m) => m.t === 'ack' && m.cmdId === 'x1')).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    ctx.tickOnce();
    await wait((m) => m.t === 'tick');
    ws.send(JSON.stringify({ t: 'timelapse', cmdId: 't1', action: 'start', shocks: [{ kind: 'storm', day: 2 }] }));
    await wait((m) => m.t === 'timelapse' && m.phase === 'done');
    expect(got.filter((m) => m.t === 'timelapse' && m.phase === 'frame').length).toBe(28);
    ws.close();
  });
});
