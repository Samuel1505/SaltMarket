import { useEffect, useState } from 'react';
import type { FeedItem } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { notifyFeed } from '../../lib/notify';
import { Button, Card } from '../../ui/primitives';
import './feed.css';

/** Glyph per feed kind; unknown kinds render as a plain line (protocol: kinds are open-ended). */
const GLYPH: Record<string, string> = {
  trade: '⇄',
  gather: '+',
  craft: '⚒',
  ship_docked: '⚓',
  ship_departed: '⛵',
  captain_ceiling: '⚓',
  npc_decision: '›',
  event_start: '⛈',
  event_end: '☀',
  MERCHANT_CLOSED: '✕',
  MERCHANT_REOPENED: '●',
  MERCHANT_RESCUED: '●',
  investor_payout: '↩',
  hall_licensed: '⌂',
  hall_fee_changed: '%',
  rent: '⌂',
};

type Filter = 'all' | 'mine' | 'news';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'Everything'],
  ['news', 'Town news'],
  ['mine', 'Yours'],
];

/** Turn new notable feed items into (rate-limited, collapsed) toasts. History from the first snapshot never toasts. */
export function useFeedToasts() {
  useEffect(() => {
    const seen = new Set<string>();
    let primed = false;
    return useGame.subscribe((s, prev) => {
      if (s.feed === prev.feed) return;
      if (!primed) {
        for (const f of s.feed) seen.add(f.id);
        primed = true;
        return;
      }
      notifyFeed(s.feed.slice(0, 20), seen);
    });
  }, []);
}

function hourOf(tick: number, ticksPerDay: number): string {
  const day = Math.floor(tick / ticksPerDay) + 1;
  const hour = tick % ticksPerDay;
  return `Day ${day} · ${String(hour).padStart(2, '0')}:00`;
}

function Line({ item, ticksPerDay }: { item: FeedItem; ticksPerDay: number }) {
  return (
    <li className="feed-item" data-notable={item.notable} data-mine={item.mine}>
      <span className="feed-glyph" aria-hidden="true">
        {GLYPH[item.kind] ?? '·'}
      </span>
      <span className="feed-text">
        {item.text}
        {item.repeat > 1 && <span className="muted num"> ×{item.repeat}</span>}
      </span>
      <span className="feed-when muted num">{hourOf(item.tick, ticksPerDay)}</span>
    </li>
  );
}

export function FeedPanel() {
  const feed = useGame((s) => s.feed);
  const ticksPerDay = useGame((s) => s.world?.catalog.ticksPerDay ?? 24);
  const [filter, setFilter] = useState<Filter>('all');
  const items = feed.filter((f) => (filter === 'mine' ? f.mine : filter === 'news' ? f.notable : true)).slice(0, 40);
  return (
    <Card
      title="Harbor news"
      className="feed"
      hint={
        <span className="feed-filters" role="group" aria-label="Show">
          {FILTERS.map(([k, label]) => (
            <Button key={k} size="sm" variant="ghost" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </Button>
          ))}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="muted feed-empty">{filter === 'mine' ? 'Nothing of yours yet. Gather something and sell it.' : 'Quiet on the harbor.'}</p>
      ) : (
        <ol className="feed-list">
          {items.map((f) => (
            <Line key={f.id} item={f} ticksPerDay={ticksPerDay} />
          ))}
        </ol>
      )}
    </Card>
  );
}
