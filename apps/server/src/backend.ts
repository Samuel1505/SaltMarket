// The seam between the HTTP/WS layer (app.ts) and whatever runs the world.
// MockBackend (scripted data) implements it today; SimBackend (packages/sim) replaces it behind the
// same endpoints. The transport layer never knows which one is active.
import type {
  AckResult,
  ClientMessage,
  Explain,
  FeedItem,
  Health,
  JudgeLedger,
  Leaderboard,
  MarketHistory,
  NpcCard,
  ServerMessage,
  Session,
  Shock,
  WorldDelta,
  WorldSnapshot,
} from '@saltmarket/shared/protocol';
import type { Good } from '@saltmarket/shared/config';

export type Fail = { ok: false; code: string; message: string };
export type Result<T> = { ok: true; data: T } | Fail;

export const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

/** Result of a player command, before the transport turns it into an `ack`. */
export type CommandOutcome = { ok: boolean; code?: string; message: string; result?: AckResult };

/** Commands the backend handles; transport-level messages (ping, subscribe, timelapse) are handled in app.ts. */
export type GameCommand = Exclude<ClientMessage, { t: 'ping' } | { t: 'subscribe' } | { t: 'timelapse' }>;

export type TimelapseOptions = { days: number; wallSeconds: number; shocks: Shock[] };
export type TimelapseEmit = (msg: Extract<ServerMessage, { t: 'timelapse' }>) => void;
export type TimelapseHandle = { id: string; totalTicks: number; stop: () => void };

export interface GameBackend {
  readonly mode: 'mock' | 'live';

  login(provider: 'guest' | 'social', displayName?: string): Result<Session>;
  /** Social/email login: verify the sign-in token and map the identity to a stable player (same player every time). */
  loginSocial(credential: string, displayName?: string): Promise<Result<Session>>;
  /** Resolve a session token to a player id, or null if unknown. */
  playerForToken(token: string): string | null;

  snapshot(playerId: string | null): WorldSnapshot;
  command(playerId: string, msg: GameCommand): CommandOutcome;

  /** Advance one tick. Called by the ticker in app.ts (or directly in tests). */
  step(): void;
  /** Delta for one viewer since the previous tick. */
  deltaFor(playerId: string | null): WorldDelta;
  /** Feed items produced by the last step, personalised for one viewer. */
  feedFor(playerId: string | null): FeedItem[];
  /** Feed items created by commands since the last clear, personalised for one viewer. */
  drainCommandFeed(playerId: string | null): FeedItem[];
  clearCommandFeed(): void;
  /** Current pacing for the ticker. */
  realMsPerTick(): number;
  isPaused(): boolean;

  npcs(playerId: string | null): NpcCard[];
  explain(npcId: string): Result<Explain>;
  history(good: Good, days: number, venueId: string | null): Result<MarketHistory>;
  leaderboard(playerId: string | null): Leaderboard;
  health(): Health;

  startTimelapse(opts: TimelapseOptions, emit: TimelapseEmit): Result<TimelapseHandle>;

  devEvent(kind: 'storm' | 'fair_winds' | 'salt_glut' | 'force_broke', npcId?: string): Result<{ message: string }>;
  devSpeed(speed?: number, paused?: boolean): Result<{ message: string }>;
  judgeLedger(limit: number): JudgeLedger;
}
