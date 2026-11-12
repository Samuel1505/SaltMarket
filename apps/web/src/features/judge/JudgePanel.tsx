import { useState } from 'react';
import { toast } from 'sonner';
import { DevOkResponse } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { api } from '../../lib/api';
import { Button } from '../../ui/primitives';
import { RULES_FILE, rulesHref } from '../npcs/NpcCards';
import './judge.css';

type EventKind = 'storm' | 'fair_winds' | 'salt_glut' | 'force_broke';
const SPEEDS = [1, 4, 16, 64] as const;

async function post(path: string, body: object): Promise<void> {
  const r = await api(path, DevOkResponse, { method: 'POST', body: JSON.stringify(body) });
  if (r.ok) toast(r.data.message);
  else toast.error(r.message);
}

/** Judge controls (?judge=1): shocks, a forced closure, and the town clock. Sits under the top bar so the reaction stays in view. */
export function JudgePanel({ onOpenLedger }: { onOpenLedger: () => void }) {
  const npcs = useGame((s) => s.world?.npcs);
  const clock = useGame((s) => s.world?.clock);
  const [busy, setBusy] = useState<string | null>(null);
  const merchants = (npcs ?? []).filter((n) => n.archetype !== 'captain' && n.status !== 'closed');
  const [target, setTarget] = useState<string>('');
  const chosen = merchants.find((m) => m.id === target) ?? merchants.find((m) => m.archetype === 'cooper') ?? merchants[0];

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    await fn();
    setBusy(null);
  }
  const fire = (kind: EventKind, npcId?: string) => run(kind, () => post('/api/dev/event', { kind, ...(npcId ? { npcId } : {}) }));
  const href = rulesHref(RULES_FILE);

  return (
    <section className="judge" aria-label="Judge controls">
      <div className="judge-inner">
        <span className="judge-tag">Judge</span>
        <div className="judge-group" role="group" aria-label="Town events">
          <Button size="sm" variant="primary" onClick={() => fire('storm')} disabled={busy !== null}>
            ⛈ Storm
          </Button>
          <Button size="sm" onClick={() => fire('fair_winds')} disabled={busy !== null}>
            Fair winds
          </Button>
          <Button size="sm" onClick={() => fire('salt_glut')} disabled={busy !== null}>
            Salt glut
          </Button>
        </div>
        <div className="judge-group" role="group" aria-label="Force a merchant broke">
          <label className="select">
            <span className="sr-only">Merchant to force broke</span>
            <select value={chosen?.id ?? ''} onChange={(e) => setTarget(e.target.value)} disabled={merchants.length === 0}>
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.title}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" onClick={() => chosen && fire('force_broke', chosen.id)} disabled={busy !== null || !chosen}>
            Force broke
          </Button>
        </div>
        {clock && (
          <div className="judge-group judge-speed" role="group" aria-label="Town clock speed">
            {SPEEDS.map((s) => (
              <Button
                key={s}
                size="sm"
                aria-pressed={!clock.paused && clock.speed === s}
                onClick={() => run(`speed${s}`, () => post('/api/dev/speed', { speed: s, paused: false }))}
                disabled={busy !== null}
              >
                ×{s}
              </Button>
            ))}
            <Button
              size="sm"
              aria-pressed={clock.paused}
              onClick={() => run('pause', () => post('/api/dev/speed', { paused: !clock.paused }))}
              disabled={busy !== null}
            >
              {clock.paused ? '▶ Resume' : '❚❚ Pause'}
            </Button>
          </div>
        )}
        <div className="judge-links">
          {href && (
            <a href={href} target="_blank" rel="noreferrer" className="judge-rules" title={RULES_FILE}>
              Pricing rules ↗
            </a>
          )}
          <Button size="sm" onClick={onOpenLedger}>
            Ledger
          </Button>
        </div>
      </div>
    </section>
  );
}
