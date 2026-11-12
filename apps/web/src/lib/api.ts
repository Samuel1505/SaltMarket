import type { z } from 'zod';
import { ApiError, ExplainResponse, LoginResponse, type Explain, type Session } from '@saltmarket/shared/protocol';
import { getSession } from './session';

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

const OFFLINE: Result<never> = { ok: false, code: 'OFFLINE', message: "Can't reach the harbor right now. Try again in a moment." };

/** REST call returning the protocol envelope, validated. Never throws. */
export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  init: RequestInit = {},
): Promise<z.infer<S> | Result<never>> {
  const headers = new Headers(init.headers);
  const token = getSession()?.token;
  if (token) headers.set('authorization', `Bearer ${token}`); // vocab-ok: auth header
  if (init.body) headers.set('content-type', 'application/json');
  try {
    const res = await fetch(path, { ...init, headers });
    const json: unknown = await res.json();
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    const err = ApiError.safeParse(json);
    return err.success ? err.data : OFFLINE;
  } catch {
    return OFFLINE;
  }
}

export async function loginGuest(displayName?: string): Promise<Result<Session>> {
  const body = JSON.stringify({ provider: 'guest', ...(displayName ? { displayName } : {}) });
  return api('/api/auth/login', LoginResponse, { method: 'POST', body });
}

// Explain payloads change at most once per tick; a short cache keeps hover-scrubbing cheap.
const explainCache = new Map<string, { at: number; data: Explain }>();
const EXPLAIN_TTL = 2500;

export async function explain(npcId: string): Promise<Result<Explain>> {
  const hit = explainCache.get(npcId);
  if (hit && performance.now() - hit.at < EXPLAIN_TTL) return { ok: true, data: hit.data };
  const r = await api(`/api/npcs/${encodeURIComponent(npcId)}/explain`, ExplainResponse);
  if (r.ok) explainCache.set(npcId, { at: performance.now(), data: r.data });
  return r;
}
