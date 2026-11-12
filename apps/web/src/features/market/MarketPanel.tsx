import { useState } from 'react';
import { cmd, formatBps, formatMarks, offersFor, quoteFor } from '@saltmarket/shared/client';
import { HARBOR_VENUE_ID, type Offer, type Quote, type Venue, type WorldSnapshot } from '@saltmarket/shared/protocol';
import { useGame } from '../../store/game';
import { act } from '../../store/act';
import { Button, Card, Trend } from '../../ui/primitives';
import { ReasonBody, ReasonPopover } from '../../ui/Reason';
import './market.css';

type Good = Quote['good'];

function OfferPrice({ offers, quote, side, goodName }: { offers: Offer[]; quote: Quote | undefined; side: Offer['side']; goodName: string }) {
  const best = offers[0];
  if (!best) return <span className="muted price-none">{side === 'buy' ? 'No buyer' : 'None for sale'}</span>;
  const verb = side === 'buy' ? 'pays' : 'asks';
  return (
    <ReasonPopover
      label={`${best.owner.name} ${verb} ${formatMarks(best.pricePips)} marks for ${goodName}. Why?`}
      trigger={
        <span className="price">
          <span className="price-value num">{formatMarks(best.pricePips)}</span>
          <span className="price-who">{best.owner.isMe ? 'you' : best.owner.name}</span>
        </span>
      }
    >
      {best.reason ? (
        <ReasonBody reason={best.reason} who={best.owner.name} />
      ) : (
        <p className="popup-title">
          {best.owner.isMe ? 'Your offer' : `${best.owner.name}'s offer`}: {formatMarks(best.pricePips)} marks each, {best.qty} left
        </p>
      )}
      {quote?.trendReason && (
        <p className="popup-section">
          <Trend trend={quote.trend} /> {quote.trendReason}
        </p>
      )}
      {offers.length > 1 && (
        <div className="popup-section">
          <p className="muted">Also {side === 'buy' ? 'buying' : 'selling'}</p>
          <ul className="offer-list">
            {offers.slice(1, 4).map((o) => (
              <li key={o.id}>
                <span>{o.owner.isMe ? 'You' : o.owner.name}</span>
                <span className="num">
                  {formatMarks(o.pricePips)} · {o.qty}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ReasonPopover>
  );
}

function GoodRow({ world, good, venueId }: { world: WorldSnapshot; good: Good; venueId: string }) {
  const [busy, setBusy] = useState<null | 'sell1' | 'sellAll' | 'buy'>(null);
  const def = world.catalog.goods.find((g) => g.id === good);
  const name = def?.name ?? good;
  const quote = quoteFor(world, venueId, good);
  const bids = offersFor(world, venueId, good, 'buy').filter((o) => !o.owner.isMe);
  const asks = offersFor(world, venueId, good, 'sell').filter((o) => !o.owner.isMe);
  const held = world.me?.inventory[good] ?? 0;
  const signedIn = !!world.me;

  async function run(kind: 'sell1' | 'sellAll' | 'buy') {
    setBusy(kind);
    if (kind === 'buy') await act(cmd({ t: 'buy', good, qty: 1, venueId }));
    else await act(cmd({ t: 'sell', good, qty: kind === 'sell1' ? 1 : held, venueId }));
    setBusy(null);
  }

  return (
    <tr>
      <th scope="row">
        <span className="good-name">{name}</span>
        {quote && (
          <span className="good-trend">
            <Trend trend={quote.trend} bps={quote.change24hBps} />
          </span>
        )}
        {quote?.trendReason && <span className="good-why">{quote.trendReason.replace(/^[^:]*:\s*/, '')}</span>}
      </th>
      <td className="col-held num">{signedIn ? held : '–'}</td>
      <td>
        <OfferPrice offers={bids} quote={quote} side="buy" goodName={name.toLowerCase()} />
      </td>
      <td>
        <OfferPrice offers={asks} quote={quote} side="sell" goodName={name.toLowerCase()} />
      </td>
      {signedIn && (
        <td className="col-actions">
          <Button size="sm" variant="primary" disabled={held < 1 || bids.length === 0 || busy !== null} onClick={() => run('sell1')} aria-label={`Sell 1 ${name.toLowerCase()}`}>
            Sell 1
          </Button>
          <Button size="sm" disabled={held < 2 || bids.length === 0 || busy !== null} onClick={() => run('sellAll')} aria-label={`Sell all ${held} ${name.toLowerCase()}`}>
            Sell all
          </Button>
          <Button size="sm" variant="ghost" disabled={asks.length === 0 || busy !== null} onClick={() => run('buy')} aria-label={`Buy 1 ${name.toLowerCase()}`}>
            Buy 1
          </Button>
        </td>
      )}
    </tr>
  );
}

function VenuePicker({ venues, value, onChange }: { venues: Venue[]; value: string; onChange: (id: string) => void }) {
  if (venues.length < 2) return null;
  return (
    <div className="venues" role="group" aria-label="Market to trade in">
      {venues.map((v) => (
        <Button key={v.id} size="sm" aria-pressed={v.id === value} onClick={() => onChange(v.id)} className="venue-btn">
          <span className="venue-name">{v.ownerIsMe ? `${v.name} (yours)` : v.name}</span>
          <span className="venue-fee num">{formatBps(v.feeBps + v.taxBps)}</span>
        </Button>
      ))}
    </div>
  );
}

export function MarketPanel() {
  const world = useGame((s) => s.world);
  const [picked, setPicked] = useState(HARBOR_VENUE_ID);
  if (!world) return null;
  const venue = world.venues.find((v) => v.id === picked) ?? world.venues.find((v) => v.id === HARBOR_VENUE_ID);
  const venueId = venue?.id ?? HARBOR_VENUE_ID;
  const cut = venue ? venue.feeBps + venue.taxBps : world.catalog.harborTaxBps;
  return (
    <Card
      title={venue?.name ?? 'Harbor Market'}
      hint={`Sell into the best offer · ${formatBps(cut)} ${venue?.kind === 'hall' ? 'fee' : 'harbor tax'}`}
      className="market"
    >
      <VenuePicker venues={world.venues} value={venueId} onChange={setPicked} />
      <div className="market-scroll">
        <table className="market-table">
          <thead>
            <tr>
              <th scope="col">Good</th>
              <th scope="col" className="col-held">
                You have
              </th>
              <th scope="col">Best buyer pays</th>
              <th scope="col">Cheapest seller</th>
              {world.me && (
                <th scope="col" className="col-actions">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {world.catalog.goods.map((g) => (
              <GoodRow key={g.id} world={world} good={g.id} venueId={venueId} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="market-foot muted">Prices in marks. Hover, tap or focus a price to see why it is what it is.</p>
    </Card>
  );
}
