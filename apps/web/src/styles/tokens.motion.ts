// Motion tokens for JS (WAAPI, timers). Mirror of the motion block in tokens.css; tokens.test.ts keeps them in sync.
// Values from emil-design-eng: strong custom ease-out for UI, ease-in-out for on-screen movement, everything < 300 ms.

export const dur = {
  press: 120,
  hover: 150,
  tooltip: 150,
  dropdown: 200,
  drawer: 300,
  pop: 220,
} as const;

export const ease = {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
  hover: 'ease',
  /** Constant motion (cooldown progress). */
  linear: 'linear',
} as const;

/** Non-animation timings (how long things stay, not how they move). */
export const hold = {
  /** "+2 fish" stays readable this long before it leaves. */
  pop: 1100,
  /** Hover delay before a reasoning tooltip opens (first one only). */
  tooltipDelay: 250,
  /** Toast lifetime. */
  toast: 4000,
  /** A changed price keeps its up/down colour this long, then eases back. */
  flash: 1200,
} as const;

/** Spring for the one decorative moment (ship arrival). Apple-style params; subtle bounce. */
export const spring = { duration: 0.5, bounce: 0.2 } as const;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * CSS `linear()` easing that traces the spring above (damping ratio = 1 − bounce), for WAAPI.
 * Lets the ship arrival use a real spring shape without a motion library. Settles within spring.duration.
 */
export function springEasing(samples = 32): string {
  const zeta = 1 - spring.bounce;
  const omega = (2 * Math.PI) / spring.duration;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * spring.duration;
    const x = i === samples ? 1 : 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
    pts.push(x.toFixed(4));
  }
  return `linear(${pts.join(', ')})`;
}
