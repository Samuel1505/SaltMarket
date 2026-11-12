import { memo, useCallback, useEffect, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { cmd, formatMarks, npcAction } from '@saltmarket/shared/client';
import type { Explain, NpcCard as Npc } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { act } from '../../store/act';
import { explain } from '../../lib/api';
import { formatSeconds, useCountdown } from '../../lib/time';
import { Badge, Button, Card, Trend } from '../../ui/primitives';
import { ReasonBody, ReasonPopover } from '../../ui/Reason';
import './npcs.css';

export const RULES_FILE = 'packages/sim/src/pricing/merchant-rules.ts';
const REPO_BLOB = 'https://github.com/Samuel1505/SaltMarket/blob/main/';
// The server sends a repo-relative path; anything else is shown as plain text, never linked.
export const rulesHref = (path: string) => (/^[\w./-]+$/.test(path) && !path.includes('..') ? REPO_BLOB + path : null);

/** Full tooltip for a merchant: fetched lazily from /api/npcs/:id/explain when it opens. */
function ExplainBody({ npc, goodName }: { npc: Npc; goodName: (g: string) => string }) {
  const [data, setData] = useState<Explain | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void explain(npc.id).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [npc.id, npc.reasoning.tick]);

  const reason = data?.reasoning ?? npc.reasoning;
  const rulesPath = data?.rulesFile ?? RULES_FILE;
  const href = rulesHref(rulesPath);
  return (
    <div className="explain">
      <ReasonBody reason={reason} who={npc.name} />
      {data && data.prices.length > 0 && (
        <ul className="popup-section explain-prices">
          {data.prices.map((p) => (
            <li key={`${p.good}:${p.side}`}>
              <span className="explain-price-head">
                <span>
                  {p.side === 'buy' ? 'Buys' : 'Sells'} {goodName(p.good)}
                </span>
                <span className="num price-value">{formatMarks(p.pricePips)}</span>
              </span>
              <span className="muted">{p.reasoning.text}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="popup-section muted">{error}</p>}
      <p className="popup-section rules">
        Read the rules:{' '}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            <code>{rulesPath}</code>
          </a>
        ) : (
          <code>{rulesPath}</code>
        )}
      </p>
    </div>
  );
}

function RescueLine({ ticks }: { ticks: number }) {
  // Reads the clock itself so only this line re-renders each tick, not the whole card.
  const clock = useGame((s) => s.world!.clock);
  const secs = useCountdown(ticks, clock);
  return <span className="num">The Town Fund steps in after {formatSeconds(secs)} if nobody does.</span>;
}

function InvestButton({ npc }: { npc: Npc }) {
  const min = npc.closed?.investMinPips ?? 0;
  const max = npc.closed?.investMaxPips ?? 0;
  const purse = useGame((s) => s.world?.me?.marksPips ?? 0);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(min);
  const [busy, setBusy] = useState(false);
  const cap = Math.min(max, purse);
  const canAfford = purse >= min;

  async function invest() {
    setBusy(true);
    const ack = await act(cmd({ t: 'invest', npcId: npc.id, amountPips: amount }));
    setBusy(false);
    if (ack.ok) setOpen(false);
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setAmount(Math.max(min, Math.min(amount, cap)));
      }}
    >
      <Popover.Trigger render={<Button variant="primary" size="sm" disabled={!canAfford} />}>Invest</Popover.Trigger>
      {!canAfford && <span className="muted npc-need num">You need at least {formatMarks(min)} marks to invest.</span>}
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} collisionPadding={16}>
          <Popover.Popup className="popup invest">
            <Popover.Title className="popup-title">Back {npc.name}'s shop</Popover.Title>
            <Popover.Description className="popup-detail">
              Your marks reopen the shop. You get a share of its profit until you're paid back 125%.
            </Popover.Description>
            <label className="invest-field">
              <span className="invest-amount num">{formatMarks(amount)} marks</span>
              <input
                className="range"
                type="range"
                min={min}
                max={Math.max(min, cap)}
                step={100}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                aria-label="Amount to invest, in marks"
                aria-valuetext={`${formatMarks(amount)} marks`}
              />
              <span className="invest-range muted num">
                <span>{formatMarks(min)}</span>
                <span>{formatMarks(Math.max(min, cap))}</span>
              </span>
            </label>
            <Button variant="primary" onClick={invest} disabled={busy || amount < min || amount > cap}>
              Invest {formatMarks(amount)} marks
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const STATUS: Record<Npc['status'], { label: string; tone: 'up' | 'warn' | 'closed' }> = {
  open: { label: '● Open', tone: 'up' },
  paused: { label: '❚❚ Paused', tone: 'warn' },
  closed: { label: '✕ Closed', tone: 'closed' },
};

const NpcCardView = memo(function NpcCardView({ npc, signedIn, goodName }: { npc: Npc; signedIn: boolean; goodName: (g: string) => string }) {
  const st = STATUS[npc.status] ?? { label: npc.status, tone: 'warn' as const };
  const action = npcAction(npc);
  return (
    <li className="npc" data-status={npc.status}>
      <div className="npc-head">
        <div className="npc-who">
          <strong className="npc-name">{npc.name}</strong>
          <span className="muted npc-title">{npc.title}</span>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="npc-purse num">
        <span className="muted">Purse</span> {formatMarks(npc.purse.pips)} <Trend trend={npc.purse.trend} />
      </div>
      <ReasonPopover label={`${npc.name}: ${npc.reasoning.text} More about this merchant's prices`} trigger={<span className="npc-reason">“{npc.reasoning.text}”</span>}>
        <ExplainBody npc={npc} goodName={goodName} />
      </ReasonPopover>

      {npc.status === 'closed' && npc.closed && (
        <div className="npc-closed">
          <strong>Closed: needs investment</strong>
          <span className="muted">
            {formatMarks(npc.closed.investMinPips)}–{formatMarks(npc.closed.investMaxPips)} marks reopens it.{' '}
            <RescueLine ticks={npc.closed.rescueInTicks} />
          </span>
          {action === 'invest' && signedIn && <InvestButton npc={npc} />}
        </div>
      )}
      {npc.investor && (
        <p className="npc-investor muted num">
          {npc.investor.isMe ? 'You backed this shop' : `Backed by ${npc.investor.displayName}`}: paid back {formatMarks(npc.investor.paidOutPips)} of{' '}
          {formatMarks(npc.investor.capPips)} marks
        </p>
      )}
      {npc.recent.length > 0 && (
        <details className="npc-recent">
          <summary>Recent decisions</summary>
          <ol>
            {npc.recent.map((d, i) => (
              <li key={`${d.tick}-${i}`}>
                {d.reasoning.text}
                {d.repeat > 1 && <span className="muted num"> ×{d.repeat}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
});

export function NpcCards() {
  const npcs = useGame((s) => s.world?.npcs);
  const catalog = useGame((s) => s.world?.catalog);
  const signedIn = useGame((s) => !!s.world?.me);
  const goodName = useCallback((g: string) => (catalog?.goods.find((x) => x.id === g)?.name ?? g).toLowerCase(), [catalog]);
  if (!npcs || !catalog) return null;
  // Closed shops first: they are the opportunity on screen.
  const sorted = [...npcs].sort((a, b) => Number(b.status === 'closed') - Number(a.status === 'closed'));
  return (
    <Card title="Town merchants" hint="Own purse, own prices">
      <ul className="npcs">
        {sorted.map((n) => (
          <NpcCardView key={n.id} npc={n} signedIn={signedIn} goodName={goodName} />
        ))}
      </ul>
    </Card>
  );
}

