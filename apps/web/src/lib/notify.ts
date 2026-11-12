import { toast } from 'sonner';
import type { FeedItem } from '@saltmarket/shared/protocol';
import { hold } from '../styles/tokens.motion';

/**
 * One door for every toast (FRONTEND.md §5): identical messages collapse into one toast with "×N",
 * and town news is rate-limited so a busy tick never buries the screen. The player's own results always show.
 */
const RATE_WINDOW_MS = 6000;
const RATE_MAX = 3; // town toasts per window; the feed panel has everything else
const recent = new Map<string, { id: string | number; count: number; at: number }>();
let townTimes: number[] = [];

export function notify(text: string, opts: { tone?: 'default' | 'error'; town?: boolean } = {}): void {
  const now = performance.now();
  const key = `${opts.tone ?? 'default'}:${text}`;
  const prev = recent.get(key);
  if (prev && now - prev.at < hold.toast) {
    prev.count += 1;
    prev.at = now;
    const label = `${text} ×${prev.count}`;
    if (opts.tone === 'error') toast.error(label, { id: prev.id });
    else toast(label, { id: prev.id });
    return;
  }
  if (opts.town) {
    townTimes = townTimes.filter((t) => now - t < RATE_WINDOW_MS);
    if (townTimes.length >= RATE_MAX) return;
    townTimes.push(now);
  }
  const id = opts.tone === 'error' ? toast.error(text) : toast(text);
  recent.set(key, { id, count: 1, at: now });
  if (recent.size > 50) for (const [k, v] of recent) if (now - v.at > hold.toast) recent.delete(k);
}

/** Toast-worthy town news from the feed: notable items not already announced by the player's own ack. */
export function notifyFeed(items: FeedItem[], seen: Set<string>): void {
  for (const it of [...items].reverse()) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (!it.notable || it.mine) continue; // the player's own results already toasted from their ack
    notify(it.repeat > 1 ? `${it.text} ×${it.repeat}` : it.text, { town: true });
  }
}
