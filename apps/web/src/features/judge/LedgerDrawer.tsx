import { useEffect, useState } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { toast } from 'sonner';
import { formatMarks } from '@saltmarket/shared/client';
import { JudgeLedgerResponse, type JudgeLedger } from '@saltmarket/shared/protocol';
import { api } from '../../lib/api';
import { Badge, Button } from '../../ui/primitives';
import './ledger.css';

const POLL_MS = 4000;

/** Only http(s) explorer links from the server are rendered as links; anything else stays plain text. */
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//.test(u) ? u : null);

function short(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-6)}` : hash;
}

function Hash({ hash, url }: { hash: string; url?: string | undefined }) {
  const href = safeUrl(url);
  async function copy() {
    try {
      await navigator.clipboard.writeText(hash);
      toast('Transaction hash copied');
    } catch {
      toast.error('Could not copy. Select the hash instead.');
    }
  }
  return (
    <span className="hash">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" title={hash}>
          <code>{short(hash)}</code> ↗
        </a>
      ) : (
        <code title={hash}>{short(hash)}</code>
      )}
      <button type="button" className="hash-copy" onClick={copy} aria-label={`Copy transaction hash ${hash}`}>
        Copy
      </button>
    </span>
  );
}

const STATUS_TONE = { settled: 'up', submitted: 'default', queued: 'default', failed: 'closed' } as const;

function LedgerBody({ data }: { data: JudgeLedger }) {
  const stuck = data.health === 'degraded' ? data.settlements.find((s) => s.error || s.status === 'failed') : undefined;
  const contractHref = safeUrl(data.contractExplorerUrl);
  return (
    <div className="ledger">
      {stuck && (
        <p className="ledger-stuck" role="alert">
          <strong>Ledger stuck at {stuck.batchId}</strong>
          {stuck.error ? `: ${stuck.error}` : ''}
        </p>
      )}
      <dl className="ledger-facts">
        <div>
          <dt>Mode</dt>
          <dd>
            <Badge tone={data.mode === 'near' ? 'up' : 'default'}>{data.mode === 'near' ? 'NEAR' : 'Memory (offline)'}</Badge>
          </dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>
            <Badge tone={data.health === 'ok' ? 'up' : data.health === 'degraded' ? 'warn' : 'closed'}>{data.health}</Badge>
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{data.network ?? '–'}</dd>
        </div>
        <div>
          <dt>Contract</dt>
          <dd className="ledger-contract">
            {data.contractId ? (
              contractHref ? (
                <a href={contractHref} target="_blank" rel="noreferrer">
                  <code>{data.contractId}</code> ↗
                </a>
              ) : (
                <code>{data.contractId}</code>
              )
            ) : (
              '–'
            )}
          </dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd className="num">{data.queueDepth} batches</dd>
        </div>
        <div>
          <dt>Last settled</dt>
          <dd className="num">{data.lastSettledTick !== null ? `tick ${data.lastSettledTick}` : '–'}</dd>
        </div>
        <div>
          <dt>Reconciliation</dt>
          <dd className="num">
            {data.reconciliation.tick !== null ? (
              <>
                {data.reconciliation.mismatches === 0 ? '✓ ' : '✕ '}
                {data.reconciliation.mismatches} mismatches at tick {data.reconciliation.tick}
              </>
            ) : (
              'not yet run'
            )}
          </dd>
        </div>
      </dl>

      <h3 className="ledger-h">Settlements</h3>
      {data.settlements.length === 0 ? (
        <p className="muted ledger-empty">No batches yet. The first one settles at the end of the game day.</p>
      ) : (
        <div className="ledger-scroll">
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Batch (ticks)</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">
                  Changes
                </th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {data.settlements.map((s) => (
                <tr key={s.batchId}>
                  <td className="num">{s.batchId}</td>
                  <td>
                    <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                    {s.attempts > 1 && <span className="muted num"> ×{s.attempts}</span>}
                    {s.error && <span className="ledger-err">{s.error}</span>}
                  </td>
                  <td className="num r">{s.deltaCount}</td>
                  <td>{s.txHash ? <Hash hash={s.txHash} url={s.explorerUrl} /> : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="ledger-h">Balances: game vs last settled</h3>
      <p className="muted ledger-note">They differ between daily batches; that is expected.</p>
      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Owner</th>
              <th scope="col">Account</th>
              <th scope="col" className="r">
                Game
              </th>
              <th scope="col" className="r">
                Settled
              </th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => {
              const href = safeUrl(a.explorerUrl);
              return (
                <tr key={`${a.ownerKind}:${a.accountId}`}>
                  <td>
                    {a.ownerName} <span className="muted">· {a.ownerKind}</span>
                  </td>
                  <td className="ledger-acct">
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer">
                        <code>{a.accountId}</code>
                      </a>
                    ) : (
                      <code>{a.accountId}</code>
                    )}
                  </td>
                  <td className="num r">{formatMarks(a.marksPips)}</td>
                  <td className="num r">{a.ledgerMarksPips !== null ? formatMarks(a.ledgerMarksPips) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Judge-only drawer (?judge=1): settlement batches, transaction hashes and balances, polled while open. */
export function LedgerDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [data, setData] = useState<JudgeLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = async () => {
      const r = await api('/api/judge/ledger?limit=20', JudgeLedgerResponse);
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.message);
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [open]);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <Drawer.Portal>
        <Drawer.Backdrop className="drawer-backdrop" />
        <Drawer.Viewport className="drawer-viewport">
          <Drawer.Popup className="drawer">
            <Drawer.Content className="drawer-content">
              <header className="drawer-head">
                <div>
                  <Drawer.Title className="drawer-title">Ledger</Drawer.Title>
                  <Drawer.Description className="muted drawer-desc">
                    Settlement of marks and goods to the chain, batched once per game day. Players never see this.
                  </Drawer.Description>
                </div>
                <Drawer.Close render={<Button size="sm" variant="ghost" />}>Close</Drawer.Close>
              </header>
              {error && !data && <p className="ledger-stuck">{error}</p>}
              {data ? <LedgerBody data={data} /> : !error && <p className="muted">Loading…</p>}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
