import { Session } from '@saltmarket/shared/protocol';

const KEY = 'saltmarket.session';
// Fallback when storage is blocked (private mode): the session lives for this page only.
let memory: Session | null = null;

export function getSession(): Session | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = Session.safeParse(JSON.parse(raw));
    memory = parsed.success ? parsed.data : null;
    return memory;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  memory = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: memory copy is enough */
  }
}

export function clearSession(): void {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
