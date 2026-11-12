import { useState, type FormEvent } from 'react';
import { cmd, formatBps, formatMarks } from '@saltmarket/shared/client';
import type { Venue, WorldSnapshot } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { act } from '../../store/act';
import { Badge, Button, Card } from '../../ui/primitives';
import './halls.css';

/** What a seller gives up at this venue: hall fee + harbor tax. Merchants move to the cheapest the next day. */
const sellerCut = (v: Venue) => v.feeBps + v.taxBps;

function FeeControl({ hall, maxBps }: { hall: Venue; maxBps: number }) {
  const [bps, setBps] = useState(hall.feeBps);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    await act(cmd({ t: 'setHallFee', hallId: hall.id, bps }));
    setBusy(false);
  }
  return (
    <div className="hall-own">
      <div className="hall-own-head">
        <strong className="hall-own-name">{hall.name}</strong>
        <Badge tone="up">Yours</Badge>
      </div>
      <div className="hall-own-stats">
        <div className="stat">
          <span className="stat-label">Fee income today</span>
          <span className="stat-value gold num">{formatMarks(hall.feeIncome24hPips)} marks</span>
        </div>
        <div className="stat">
          <span className="stat-label">All time</span>
          <span className="stat-value num">{formatMarks(hall.feeIncomeTotalPips)} marks</span>
        </div>
        <div className="stat">
          <span className="stat-label">Traded today</span>
          <span className="stat-value num">{formatMarks(hall.volume24hPips)} marks</span>
        </div>
      </div>
      <label className="hall-fee">
        <span className="hall-fee-row">
          <span>Your fee</span>
          <span className="num hall-fee-value">{formatBps(bps)}</span>
        </span>
        <input
          className="range"
          type="range"
          min={0}
          max={maxBps}
          step={25}
          value={bps}
          onChange={(e) => setBps(Number(e.target.value))}
          aria-valuetext={formatBps(bps)}
        />
        <span className="hall-fee-row muted num">
          <span>0% (draws merchants)</span>
          <span>{formatBps(maxBps)} (more per trade)</span>
        </span>
      </label>
      <Button size="sm" variant="primary" onClick={save} disabled={busy || bps === hall.feeBps} className="hall-fee-save">
        {bps === hall.feeBps ? `Fee is ${formatBps(bps)}` : `Set fee to ${formatBps(bps)}`}
      </Button>
    </div>
  );
}

function BuyHall({ world }: { world: WorldSnapshot }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const cost = world.catalog.hallLicensePips;
  const purse = world.me?.marksPips ?? 0;
  const trimmed = name.trim();
  const nameOk = trimmed.length === 0 || (trimmed.length >= 2 && trimmed.length <= 40);
  async function buy(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ack = await act(cmd({ t: 'buyHall', ...(trimmed ? { name: trimmed } : {}) }));
    setBusy(false);
    if (ack.ok) setName('');
  }
  return (
    <form className="hall-buy" onSubmit={buy}>
      <div className="hall-buy-text">
        <strong>Open your own Exchange Hall</strong>
        <span className="muted">
          Set a fee and earn a cut of every trade made there. A license costs <span className="num gold">{formatMarks(cost)} marks</span>.
          {purse < cost && <> You have {formatMarks(purse)}.</>}
        </span>
      </div>
      <div className="hall-buy-row">
        <label className="field">
          <span className="sr-only">Hall name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name (optional)" />
        </label>
        <Button type="submit" variant="primary" disabled={busy || purse < cost || !nameOk}>
          Buy license
        </Button>
      </div>
    </form>
  );
}

export function HallsPanel() {
  const world = useGame((s) => s.world);
  if (!world) return null;
  const venues = [...world.venues].sort((a, b) => sellerCut(a) - sellerCut(b));
  const cheapest = venues[0] ? sellerCut(venues[0]) : 0;
  const mine = world.venues.filter((v) => v.kind === 'hall' && v.ownerIsMe);
  return (
    <Card title="Exchange Halls" hint="Rival markets compete on fees" className="halls">
      <div className="halls-scroll">
        <table className="halls-table">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col" className="r">
                Seller pays
              </th>
              <th scope="col" className="r">
                Traded today
              </th>
              <th scope="col" className="r">
                Owner earned
              </th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr key={v.id} data-mine={v.ownerIsMe}>
                <th scope="row">
                  <span className="halls-name">{v.name}</span>
                  <span className="halls-owner muted">
                    {v.kind === 'harbor' ? 'Town market' : v.ownerIsMe ? 'Yours' : `Run by ${v.ownerName ?? 'a player'}`}
                    {sellerCut(v) === cheapest && venues.length > 1 && <> · cheapest</>}
                  </span>
                </th>
                <td className="r num">
                  {formatBps(sellerCut(v))}
                  <span className="halls-split muted">{v.kind === 'harbor' ? 'tax' : `fee${v.taxBps ? ' + tax' : ''}`}</span>
                </td>
                <td className="r num">{formatMarks(v.volume24hPips)}</td>
                <td className="r num">{v.kind === 'hall' ? formatMarks(v.feeIncome24hPips) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mine.map((h) => (
        <FeeControl key={`${h.id}:${h.feeBps}`} hall={h} maxBps={world.catalog.hallFeeMaxBps} />
      ))}
      {world.me && <BuyHall world={world} />}
    </Card>
  );
}
