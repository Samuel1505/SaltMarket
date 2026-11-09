// HTTP + WebSocket transport. Talks only to GameBackend, so mock and live share every route.
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { GOODS, type Good } from '@saltmarket/shared/config';
import {
  ClientMessage, DevEventRequest, DevSpeedRequest, LoginRequest, PROTOCOL_VERSION, ServerMessage, TimelapseRequest,
  type ServerMessage as ServerMessageT,
} from '@saltmarket/shared/protocol';
import { ECONOMY } from '@saltmarket/shared/config';
import type { GameBackend, Result, TimelapseHandle } from './backend.js';

export type AppOptions = { judge: boolean; autoTick: boolean; validateOutgoing: 'off' | 'log' | 'throw'; logger?: boolean | object };

type Conn = { id: number; send: (m: ServerMessageT) => void; playerId: string | null; timelapse?: TimelapseHandle; window: number[] };

const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, BAD_CREDENTIAL: 401, SOCIAL_UNAVAILABLE: 501, JUDGE_ONLY: 403, NOT_FOUND: 404, RATE_LIMITED: 429, TIMELAPSE_BUSY: 429, INTERNAL: 500 };

export async function buildApp(backend: GameBackend, opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const conns = new Set<Conn>();
  let nextId = 1;

  const check = (m: ServerMessageT): void => {
    if (opts.validateOutgoing === 'off') return;
    const r = ServerMessage.safeParse(m);
    if (r.success) return;
    const msg = `outgoing ${m.t} violates protocol: ${r.error.message}`;
    if (opts.validateOutgoing === 'throw') throw new Error(msg);
    app.log.error(msg);
  };

  const tokenOf = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    const q = (req.query as Record<string, unknown> | undefined)?.token;
    return typeof q === 'string' ? q : null;
  };
  const playerOf = (req: FastifyRequest): string | null => {
    const t = tokenOf(req);
    return t ? backend.playerForToken(t) : null;
  };
  const reply = <T>(res: FastifyReply, r: Result<T>) =>
    r.ok ? res.send(r) : res.code(STATUS[r.code] ?? 400).send(r);
  const bad = (res: FastifyReply, message: string) => res.code(400).send({ ok: false, code: 'BAD_REQUEST', message });
  const judgeOnly = (res: FastifyReply) => res.code(403).send({ ok: false, code: 'JUDGE_ONLY', message: 'Judge mode is off on this server.' });

  // ── REST ──
  app.get('/healthz', async () => backend.health());

  app.post('/api/auth/login', async (req, res) => {
    const body = LoginRequest.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 'Sign-in details look wrong.');
    if (body.data.provider === 'social') {
      if (!body.data.credential) return res.code(401).send({ ok: false, code: 'BAD_CREDENTIAL', message: 'Sign-in failed. Please try again.' });
      return reply(res, await backend.loginSocial(body.data.credential, body.data.displayName));
    }
    return reply(res, backend.login('guest', body.data.displayName));
  });

  app.get('/api/world', async (req, res) => res.send({ ok: true, data: backend.snapshot(playerOf(req)) }));
  app.get('/api/npcs', async (req, res) => res.send({ ok: true, data: { npcs: backend.npcs(playerOf(req)) } }));
  app.get<{ Params: { id: string } }>('/api/npcs/:id/explain', async (req, res) => reply(res, backend.explain(req.params.id)));
  app.get<{ Params: { good: string }; Querystring: { days?: string; venueId?: string } }>('/api/market/:good/history', async (req, res) => {
    if (!(GOODS as readonly string[]).includes(req.params.good)) return res.code(404).send({ ok: false, code: 'NOT_FOUND', message: 'No such good.' });
    const days = Number(req.query.days ?? 5);
    return reply(res, backend.history(req.params.good as Good, Number.isFinite(days) ? days : 5, req.query.venueId ?? null));
  });
  app.get('/api/leaderboard', async (req, res) => res.send({ ok: true, data: backend.leaderboard(playerOf(req)) }));

  app.post('/api/timelapse', async (req, res) => {
    const body = TimelapseRequest.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 'Time-lapse options look wrong.');
    const pid = playerOf(req);
    const conn = [...conns].find((c) => c.playerId !== null && c.playerId === pid);
    if (!conn) return bad(res, 'Open the game connection first; frames stream over it.');
    const r = startTimelapse(conn, body.data);
    return r.ok ? res.send({ ok: true, data: { timelapseId: r.data.id, totalTicks: r.data.totalTicks } }) : reply(res, r);
  });

  app.post('/api/dev/event', async (req, res) => {
    if (!opts.judge) return judgeOnly(res);
    const body = DevEventRequest.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 'Unknown event.');
    return reply(res, backend.devEvent(body.data.kind, body.data.npcId));
  });
  app.post('/api/dev/speed', async (req, res) => {
    if (!opts.judge) return judgeOnly(res);
    const body = DevSpeedRequest.safeParse(req.body ?? {});
    if (!body.success) return bad(res, 'Speed must be between 0 and 64.');
    const r = backend.devSpeed(body.data.speed, body.data.paused);
    reschedule();
    return reply(res, r);
  });
  app.get<{ Querystring: { limit?: string } }>('/api/judge/ledger', async (req, res) => {
    if (!opts.judge) return judgeOnly(res);
    return res.send({ ok: true, data: backend.judgeLedger(Number(req.query.limit ?? 50) || 50) });
  });

  // ── WebSocket ──
  const startTimelapse = (conn: Conn, o: { days?: number | undefined; wallSeconds?: number | undefined; shocks?: unknown[] | undefined }): Result<TimelapseHandle> => {
    if (conn.timelapse) return { ok: false, code: 'TIMELAPSE_BUSY', message: 'A time-lapse is already playing for you.' };
    const r = backend.startTimelapse(
      { days: o.days ?? 7, wallSeconds: o.wallSeconds ?? ECONOMY.timelapse.targetWallSeconds, shocks: (o.shocks ?? []) as never },
      (m) => {
        conn.send(m);
        if (m.phase === 'done' || m.phase === 'stopped') delete conn.timelapse;
      },
    );
    if (r.ok) conn.timelapse = r.data;
    return r;
  };

  app.get('/ws', { websocket: true }, (socket, req) => {
    const conn: Conn = {
      id: nextId++, playerId: playerOf(req), window: [],
      send: (m) => { check(m); if (socket.readyState === 1) socket.send(JSON.stringify(m)); },
    };
    conns.add(conn);
    conn.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION, serverMode: backend.mode, playerId: conn.playerId });
    conn.send({ t: 'snapshot', world: backend.snapshot(conn.playerId) });

    socket.on('message', (raw: Buffer) => {
      const now = Date.now();
      conn.window = conn.window.filter((t) => now - t < 1000);
      conn.window.push(now);
      let data: unknown;
      try { data = JSON.parse(raw.toString()); } catch { return conn.send({ t: 'error', code: 'BAD_REQUEST', message: 'Message was not valid JSON.' }); }
      const cmdId = typeof (data as { cmdId?: unknown })?.cmdId === 'string' ? (data as { cmdId: string }).cmdId : null;
      const parsed = ClientMessage.safeParse(data);
      if (!parsed.success) {
        return cmdId ? conn.send({ t: 'ack', cmdId, ok: false, code: 'BAD_REQUEST', message: 'That action was not understood.' })
                     : conn.send({ t: 'error', code: 'BAD_REQUEST', message: 'That message was not understood.' });
      }
      const msg = parsed.data;
      if (conn.window.length > 20) return conn.send({ t: 'ack', cmdId: msg.cmdId, ok: false, code: 'RATE_LIMITED', message: 'Slow down a little.' });
      switch (msg.t) {
        case 'ping': return conn.send({ t: 'pong', cmdId: msg.cmdId });
        case 'subscribe': return conn.send({ t: 'ack', cmdId: msg.cmdId, ok: true, message: 'Subscribed.', result: { kind: 'none' } });
        case 'timelapse': {
          if (msg.action === 'stop') {
            if (!conn.timelapse) return conn.send({ t: 'ack', cmdId: msg.cmdId, ok: false, code: 'NOT_FOUND', message: 'No time-lapse is playing.' });
            conn.timelapse.stop();
            return conn.send({ t: 'ack', cmdId: msg.cmdId, ok: true, message: 'Time-lapse stopped.', result: { kind: 'none' } });
          }
          const r = startTimelapse(conn, msg);
          return r.ok
            ? conn.send({ t: 'ack', cmdId: msg.cmdId, ok: true, message: 'Watching a week of trading…', result: { kind: 'timelapse', timelapseId: r.data.id } })
            : conn.send({ t: 'ack', cmdId: msg.cmdId, ok: false, code: r.code, message: r.message });
        }
        default: {
          if (!conn.playerId) return conn.send({ t: 'ack', cmdId: msg.cmdId, ok: false, code: 'UNAUTHORIZED', message: 'Please sign in to trade.' });
          backend.clearCommandFeed();
          const out = backend.command(conn.playerId, msg);
          conn.send({ t: 'ack', cmdId: msg.cmdId, ...out });
          // Push the effects right away so the purse and inventory don't wait for the next tick.
          const tick = backend.health().tick;
          for (const c of conns) {
            const items = backend.drainCommandFeed(c.playerId);
            if (items.length) c.send({ t: 'feed', items });
            if (out.ok) c.send({ t: 'delta', tick, changes: backend.deltaFor(c.playerId) });
          }
          backend.clearCommandFeed();
        }
      }
    });
    socket.on('close', () => { conn.timelapse?.stop(); conns.delete(conn); });
  });

  // ── Ticker ──
  const tickOnce = () => {
    backend.step();
    const snap = backend.health();
    const clock = backend.deltaFor(null).clock;
    for (const c of conns) {
      c.send({ t: 'tick', tick: snap.tick, day: clock.day, hour: clock.hour });
      c.send({ t: 'delta', tick: snap.tick, changes: backend.deltaFor(c.playerId) });
      const items = backend.feedFor(c.playerId);
      if (items.length) c.send({ t: 'feed', items });
    }
  };
  let timer: NodeJS.Timeout | null = null;
  const loop = () => {
    timer = setTimeout(() => { if (!backend.isPaused()) tickOnce(); loop(); }, backend.realMsPerTick());
  };
  function reschedule() {
    if (!opts.autoTick) return;
    if (timer) clearTimeout(timer);
    loop();
  }
  if (opts.autoTick) loop();
  app.addHook('onClose', async () => {
    if (timer) clearTimeout(timer);
    for (const c of conns) c.timelapse?.stop();
  });

  return { app, tickOnce, connections: () => conns.size };
}
