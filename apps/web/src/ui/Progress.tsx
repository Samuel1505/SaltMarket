import { useEffect, useRef } from 'react';
import type { Clock } from '@saltmarket/shared/protocol';
import { ease, prefersReducedMotion } from '../styles/tokens.motion';

/**
 * Progress of a timed job (crafting). The server tick is the truth; between ticks the bar runs on WAAPI
 * (linear, transform only, off the main thread) and re-anchors on every tick.
 */
export function JobProgress({ startedTick, doneTick, clock, label }: { startedTick: number; doneTick: number; clock: Clock; label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const span = Math.max(1, doneTick - startedTick);
  const done = Math.max(0, Math.min(1, (clock.tick - startedTick) / span));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `scaleX(${done})`;
    const left = (doneTick - clock.tick) * clock.realMsPerTick;
    if (done >= 1 || left <= 0 || clock.paused || prefersReducedMotion()) return;
    const anim = el.animate([{ transform: `scaleX(${done})` }, { transform: 'scaleX(1)' }], { duration: left, easing: ease.linear, fill: 'forwards' });
    return () => anim.cancel();
  }, [done, doneTick, clock.tick, clock.realMsPerTick, clock.paused]);
  return (
    <div className="meter meter-job" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)}>
      <span ref={ref} />
    </div>
  );
}
