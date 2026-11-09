// Protocol conformance suite, run against every GameBackend (mock and live) through the real
// HTTP + WS transport. A backend passes only if every message it emits parses against protocol.ts
// and the behaviours the frontend relies on hold. Uses only judge routes and a fresh world, never
// backend-specific scripting.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExplainResponse, Health, JudgeLedgerResponse, LeaderboardResponse, LoginResponse, MarketHistoryResponse,
  NpcsResponse, ServerMessage, WorldResponse, type ServerMessage as SM,
} from '@saltmarket/shared/protocol';
import { buildApp } from './app.js';
import type { GameBackend } from './backend.js';

export type BackendFactory = (opts: { timelapseFrameMs: number }) => GameBackend;

export function conformanceSuite(name: string, make: BackendFactory): void {
  describe(`protocol conformance: ${name}`, () => {
    let ctx: Awaited<ReturnType<typeof buildApp>>;
    let off: Awaited<ReturnType<typeof buildApp>>;
    let host = '';
    beforeAll(async () => {
      ctx = await buildApp(make({ timelapseFrameMs: 1 }), { judge: true, autoTick: false, validateOutgoing: 'throw' });
      off = await buildApp(make({ timelapseFrameMs: 1 }), { judge: false, autoTick: false, validateOutgoing: 'throw' });
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const a = ctx.app.server.address();
      host = typeof a === 'object' && a ? `127.0.0.1:${a.port}` : '';
      for (let i = 0; i < 3; i++) ctx.tickOnce(); // let merchants post their first offers
    });
    afterAll(async () => { await ctx.app.close(); await off.app.close(); });

    const login = async (displayName = 'Conformance') => {
      const r = LoginResponse.parse((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { provider: 'guest', displayName } })).json());
      if (!r.ok) throw new Error(r.message);
      return r.data;
    };
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    it('REST responses parse in the fixed envelope', async () => {
      const s = await login();
      const world = WorldResponse.parse((await ctx.app.inject({ url: '/api/world', headers: auth(s.token) })).json());
      expect(world.ok && world.data.me?.playerId).toBe(s.playerId);
      expect(world.ok && world.data.npcs.length).toBeGreaterThan(5);
      const npcs = NpcsResponse.parse((await ctx.app.inject({ url: '/api/npcs' })).json());
      const firstNpc = npcs.ok ? npcs.data.npcs[0]!.id : '';
      expect(ExplainResponse.parse((await ctx.app.inject({ url: `/api/npcs/${firstNpc}/explain` })).json()).ok).toBe(true);
      const missing = await ctx.app.inject({ url: '/api/npcs/nobody/explain' });
      expect(missing.statusCode).toBe(404);
      expect(ExplainResponse.parse(missing.json())).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(MarketHistoryResponse.parse((await ctx.app.inject({ url: '/api/market/fish/history?days=5' })).json()).ok).toBe(true);
      expect((await ctx.app.inject({ url: '/api/market/gold/history' })).statusCode).toBe(404);
      expect(LeaderboardResponse.parse((await ctx.app.inject({ url: '/api/leaderboard', headers: auth(s.token) })).json()).ok).toBe(true);
      expect(JudgeLedgerResponse.parse((await ctx.app.inject({ url: '/api/judge/ledger' })).json()).ok).toBe(true);
      Health.parse((await ctx.app.inject({ url: '/healthz' })).json());
      expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { provider: 'nope' } })).statusCode).toBe(400);
    });

    it('judge routes are refused when judge mode is off', async () => {
      for (const [method, url, payload] of [
        ['POST', '/api/dev/event', { kind: 'storm' }], ['POST', '/api/dev/event', { kind: 'force_broke' }],
        ['POST', '/api/dev/speed', { speed: 4 }], ['GET', '/api/judge/ledger', undefined],
      ] as const) {
        const r = await off.app.inject({ method, url, ...(payload ? { payload } : {}) });
        expect(r.statusCode).toBe(403);
        expect(r.json()).toMatchObject({ ok: false, code: 'JUDGE_ONLY' });
      }
    });

    it('WS: hello + snapshot, acks for success and failure, ticks, deltas, feed', async () => {
      const s = await login('Socket');
      const ws = new WebSocket(`ws://${host}/ws?token=${s.token}`);
      const got: SM[] = [];
      ws.onmessage = (e) => got.push(ServerMessage.parse(JSON.parse(String(e.data))));
      await new Promise((r) => (ws.onopen = r));
      const wait = async (pred: (m: SM) => boolean) => {
        for (let i = 0; i < 300; i++) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
        throw new Error('timed out waiting for a message');
      };
      const send = async (m: Record<string, unknown>) => {
        ws.send(JSON.stringify(m));
        return wait((x) => x.t === 'ack' && x.cmdId === m.cmdId) as Promise<Extract<SM, { t: 'ack' }>>;
      };
      await wait((m) => m.t === 'hello');
      expect(got[0]?.t).toBe('hello');
      await wait((m) => m.t === 'snapshot');

      // The approved first loop: gather → sell.
      expect(await send({ t: 'gather', cmdId: 'g1', node: 'pier' })).toMatchObject({ ok: true, result: { kind: 'gathered', good: 'fish' } });
      expect(await send({ t: 'gather', cmdId: 'g2', node: 'pier' })).toMatchObject({ ok: false, code: 'COOLDOWN' });
      expect(await send({ t: 'sell', cmdId: 's1', good: 'fish', qty: 2, venueId: 'harbor' })).toMatchObject({ ok: true, result: { kind: 'trade', side: 'sell' } });
      expect(await send({ t: 'sell', cmdId: 's2', good: 'cured_fish', qty: 1, venueId: 'harbor' })).toMatchObject({ ok: false, code: 'INSUFFICIENT_GOODS' });
      expect(await send({ t: 'craft', cmdId: 'c1', recipe: 'cure_fish' })).toMatchObject({ ok: false, code: 'INSUFFICIENT_GOODS' });
      expect(await send({ t: 'setHallFee', cmdId: 'h1', hallId: 'hall-404', bps: 100 })).toMatchObject({ ok: false });
      expect(await send({ t: 'fly', cmdId: 'x1' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      ws.send('not json');
      await wait((m) => m.t === 'error');
      ws.send(JSON.stringify({ t: 'ping', cmdId: 'p1' }));
      await wait((m) => m.t === 'pong');

      for (let i = 0; i < 30; i++) ctx.tickOnce();
      await wait((m) => m.t === 'tick');
      await wait((m) => m.t === 'delta');
      ws.close();
    });

    it('WS: spectators can watch but not act', async () => {
      const ws = new WebSocket(`ws://${host}/ws`);
      const got: SM[] = [];
      ws.onmessage = (e) => got.push(ServerMessage.parse(JSON.parse(String(e.data))));
      await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ t: 'gather', cmdId: 'g1', node: 'pier' }));
      for (let i = 0; i < 100 && !got.some((m) => m.t === 'ack'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(got.find((m) => m.t === 'ack')).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
      expect(got.find((m) => m.t === 'snapshot')).toMatchObject({ world: { me: null } });
      ws.close();
    });

    it('closure and investment: force_broke → invest reopens; open merchants refuse', async () => {
      const s = await login('Investor');
      const broke = await ctx.app.inject({ method: 'POST', url: '/api/dev/event', payload: { kind: 'force_broke', npcId: 'cooper' } });
      expect(broke.json().ok).toBe(true);
      ctx.tickOnce();
      const world = WorldResponse.parse((await ctx.app.inject({ url: '/api/world', headers: auth(s.token) })).json());
      const cooper = world.ok ? world.data.npcs.find((n) => n.id === 'cooper') : undefined;
      expect(cooper?.status).toBe('closed');
      expect(cooper?.closed?.investMinPips).toBeGreaterThan(0);
      const ws = new WebSocket(`ws://${host}/ws?token=${s.token}`);
      const got: SM[] = [];
      ws.onmessage = (e) => got.push(ServerMessage.parse(JSON.parse(String(e.data))));
      await new Promise((r) => (ws.onopen = r));
      const send = async (m: Record<string, unknown>) => {
        ws.send(JSON.stringify(m));
        for (let i = 0; i < 200; i++) { const a = got.find((x) => x.t === 'ack' && x.cmdId === m.cmdId); if (a) return a; await new Promise((r) => setTimeout(r, 10)); }
        throw new Error('no ack');
      };
      expect(await send({ t: 'invest', cmdId: 'i0', npcId: 'fisher-1', amountPips: 20000 })).toMatchObject({ ok: false, code: 'MERCHANT_OPEN' });
      expect(await send({ t: 'invest', cmdId: 'i1', npcId: 'cooper', amountPips: 1 })).toMatchObject({ ok: false, code: 'INVEST_OUT_OF_RANGE' });
      expect(await send({ t: 'invest', cmdId: 'i2', npcId: 'cooper', amountPips: 20000 })).toMatchObject({ ok: true, result: { kind: 'invested' } });
      expect(await send({ t: 'invest', cmdId: 'i3', npcId: 'cooper', amountPips: 20000 })).toMatchObject({ ok: false });
      ws.close();
    });

    it('storm and ship: events appear and the ship docks within 60 ticks of a fresh world', async () => {
      const b = make({ timelapseFrameMs: 1 });
      b.devEvent('storm');
      let storm = false;
      let docked = false;
      for (let i = 0; i < 60; i++) {
        b.step();
        const snap = b.snapshot(null);
        if (snap.events.some((e) => e.kind === 'storm')) storm = true;
        if (snap.ship.status === 'docked') docked = true;
      }
      expect(storm).toBe(true);
      expect(docked).toBe(true);
    });

    it('time-lapse streams 28 frames then done, and leaves the live world untouched', async () => {
      const s = await login('Watcher');
      const ws = new WebSocket(`ws://${host}/ws?token=${s.token}`);
      const got: SM[] = [];
      ws.onmessage = (e) => got.push(ServerMessage.parse(JSON.parse(String(e.data))));
      await new Promise((r) => (ws.onopen = r));
      const before = Health.parse((await ctx.app.inject({ url: '/healthz' })).json()).tick;
      ws.send(JSON.stringify({ t: 'timelapse', cmdId: 't1', action: 'start', shocks: [{ kind: 'storm', day: 2 }, { kind: 'close_merchant', day: 3, investDay: 4 }] }));
      for (let i = 0; i < 500 && !got.some((m) => m.t === 'timelapse' && m.phase === 'done'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(got.filter((m) => m.t === 'timelapse' && m.phase === 'frame')).toHaveLength(28);
      expect(Health.parse((await ctx.app.inject({ url: '/healthz' })).json()).tick).toBe(before);
      ws.close();
    });
  });
}
