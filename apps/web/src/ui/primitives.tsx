import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Quote } from '@saltmarket/shared/protocol';
import { trendGlyph } from '@saltmarket/shared/client';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost';
  size?: 'md' | 'sm';
};

/** Every pressable control: press feedback (scale on :active), clear disabled state, 40 px hit target. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} data-variant={variant} data-size={size} className={clsx('btn', className)} {...rest} />;
});

export function Card({ title, hint, className, children, ...rest }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; hint?: ReactNode }) {
  return (
    <section className={clsx('card', className)} {...rest}>
      {(title || hint) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {hint && <span className="hint">{hint}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Direction glyph + colour (never colour alone). */
export function Trend({ trend, bps }: { trend: Quote['trend']; bps?: number }) {
  const cls = trend === 'up' ? 'up' : trend === 'down' ? 'down' : 'muted';
  const label = trend === 'up' ? 'up' : trend === 'down' ? 'down' : 'flat';
  return (
    <span className={clsx('num', cls)} aria-label={bps !== undefined ? `${label} ${Math.abs(bps / 100).toFixed(0)}%` : label}>
      <span aria-hidden="true">
        {trendGlyph(trend)}
        {bps !== undefined && trend !== 'flat' ? ` ${Math.abs(bps / 100).toFixed(0)}%` : ''}
      </span>
    </span>
  );
}

export function Stat({ label, value, delta, className }: { label: ReactNode; value: ReactNode; delta?: ReactNode; className?: string }) {
  return (
    <div className={clsx('stat', className)}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {delta && <span className="stat-delta">{delta}</span>}
    </div>
  );
}

export function Badge({ tone = 'default', children }: { tone?: 'default' | 'up' | 'warn' | 'closed'; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ transform: `scaleX(${ratio})` }} />
    </div>
  );
}
