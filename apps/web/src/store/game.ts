import { create } from 'zustand';
import { ServerMessage, type ClientMessage, type FeedItem, type WorldSnapshot } from '@saltmarket/shared/protocol';
import { applyDelta, applyFeed } from '@saltmarket/shared/client';
import { clearSession, getSession } from '../lib/session';

export type Ack = Extract<ServerMessage, { t: 'ack' }>;
export type TimelapseMsg = Extract<ServerMessage, { t: 'timelapse' }>;
export type ConnStatus = 'connecting' | 'open' | 'reconnecting';

type GameState = {
  world: WorldSnapshot | null;
  feed: FeedItem[];
  status: ConnStatus;
  /** playerId from `hello`; null = spectator. */
  playerId: string | null;
  /** Set when a stored session was rejected (hello came back without a player). */
  sessionExpired: boolean;
};

export const useGame = create<GameState>(() => ({
  world: null,
  feed: [],
  status: 'connecting',
  playerId: null,
  sessionExpired: false,
}));

// ───────── socket lifecycle ─────────

let ws: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<string, { resolve: (a: Ack) => void; timer: ReturnType<typeof setTimeout> }>();
const timelapseListeners = new Set<(m: TimelapseMsg) => void>();
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const ACK_TIMEOUT_MS = 10000;

function wsUrl(token: string | null): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = token ? `?token=${encodeURIComponent(token)}` : ''; // vocab-ok: protocol query parameter
  return `${proto}://${location.host}/ws${q}`;
}

/** (Re)connect with the stored session, or as a spectator without one. */
export function connect(): void {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  const session = getSession();
  const sock = new WebSocket(wsUrl(session?.token ?? null));
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
  };
  sock.onmessage = (e) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success) return; // unknown or newer message type: ignore
    enqueue(parsed.data);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    useGame.setState({ status: 'reconnecting' });
    failPending("Lost the connection to the harbor. Reconnecting…");
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  };
}

/** Send a command; resolves with its one ack (or a local failure if the socket is down or silent). */
export function send(m: ClientMessage): Promise<Ack> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ t: 'ack', cmdId: m.cmdId, ok: false, code: 'OFFLINE', message: 'Not connected yet. Try again in a moment.' });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(m.cmdId);
      resolve({ t: 'ack', cmdId: m.cmdId, ok: false, code: 'TIMEOUT', message: 'The harbor did not answer. Try again.' });
    }, ACK_TIMEOUT_MS);
    pending.set(m.cmdId, { resolve, timer });
    ws.send(JSON.stringify(m));
  });
}

export function onTimelapse(fn: (m: TimelapseMsg) => void): () => void {
  timelapseListeners.add(fn);
  return () => timelapseListeners.delete(fn);
}

function failPending(message: string) {
  for (const [cmdId, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ t: 'ack', cmdId, ok: false, code: 'OFFLINE', message });
  }
  pending.clear();
}

// ───────── batching: apply everything that arrived within one frame in a single store update ─────────

let queue: ServerMessage[] = [];
let scheduled = false;

function enqueue(m: ServerMessage) {
  queue.push(m);
  if (scheduled) return;
  scheduled = true;
  // rAF doesn't run in background tabs; a timer keeps acks flowing there.
  if (document.hidden) setTimeout(flush, 50);
  else requestAnimationFrame(flush);
}

function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  const s = useGame.getState();
  let { world, feed, playerId, status, sessionExpired } = s;
  const acks: Ack[] = [];
  for (const m of batch) {
    switch (m.t) {
      case 'hello':
        playerId = m.playerId;
        status = 'open';
        if (!m.playerId && getSession()) {
          clearSession(); // stored session is no longer valid: sign in again
          sessionExpired = true;
        }
        break;
      case 'snapshot':
        world = m.world;
        feed = m.world.feed;
        status = 'open';
        break;
      case 'delta':
        if (world) world = applyDelta(world, m.changes);
        break;
      case 'feed':
        feed = applyFeed(feed, m.items);
        break;
      case 'ack':
        acks.push(m);
        break;
      case 'timelapse':
        for (const fn of timelapseListeners) fn(m);
        break;
      default:
        break; // tick, pong, error: nothing to store
    }
  }
  if (world !== s.world || feed !== s.feed || playerId !== s.playerId || status !== s.status || sessionExpired !== s.sessionExpired) {
    useGame.setState({ world, feed, playerId, status, sessionExpired });
  }
  // Resolve acks after the world update, so the purse/inventory a toast talks about is already on screen.
  for (const a of acks) {
    const p = pending.get(a.cmdId);
    if (!p) continue;
    clearTimeout(p.timer);
    pending.delete(a.cmdId);
    p.resolve(a);
  }
}
