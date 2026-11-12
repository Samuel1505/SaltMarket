import { DEV_DATA } from './fixtures';
import { notify } from '../lib/notify';
import { useEffect } from 'react';
import './dev.css';

const STATES: Array<[string, string]> = [
  ['', 'Demo data'],
  ['worst', 'Worst case'],
  ['empty', 'Empty'],
];

/** Dev-only break-ui toggle (never shipped: rendered only when import.meta.env.DEV). Plain chrome on purpose. */
export function DevToggle() {
  useEffect(() => {
    // Worst case also means 20 toasts at once.
    if (DEV_DATA === 'worst') for (let i = 0; i < 20; i++) notify(i % 2 ? 'Agathe went broke and closed.' : `Storm news ${i}`, { town: true });
  }, []);
  const href = (v: string) => {
    const u = new URL(location.href);
    if (v) u.searchParams.set('data', v);
    else u.searchParams.delete('data');
    return u.toString();
  };
  return (
    <nav className="devtoggle" aria-label="Dev data">
      {STATES.map(([v, label]) => (
        <a key={v} href={href(v)} aria-current={(DEV_DATA ?? '') === v ? 'true' : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
