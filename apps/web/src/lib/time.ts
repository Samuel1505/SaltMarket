import { useEffect, useRef, useState } from 'react';
import type { Clock } from '@saltmarket/shared/protocol';

/**
 * Smooth countdown between ticks. Game logic stays on `clock.tick`; this only interpolates the seconds shown,
 * re-anchoring every time the server's tick (or the remaining ticks) changes.
 */
export function useCountdown(ticksLeft: number, clock: Clock): number {
  const deadline = useRef(0);
  const [now, setNow] = useState(() => performance.now());

  // Re-anchor on every server update.
  const anchor = performance.now() + Math.max(0, ticksLeft) * clock.realMsPerTick;
  const key = `${clock.tick}:${ticksLeft}:${clock.realMsPerTick}:${clock.paused}`;
  const lastKey = useRef('');
  if (lastKey.current !== key) {
    lastKey.current = key;
    deadline.current = anchor;
  }

  useEffect(() => {
    if (ticksLeft <= 0 || clock.paused) return;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [ticksLeft, clock.paused]);

  if (ticksLeft <= 0) return 0;
  if (clock.paused) return Math.ceil((ticksLeft * clock.realMsPerTick) / 1000);
  return Math.max(0, Math.ceil((deadline.current - now) / 1000));
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

export function formatClock(clock: Clock): string {
  return `Day ${clock.day + 1} · ${String(clock.hour).padStart(2, '0')}:00`;
}
