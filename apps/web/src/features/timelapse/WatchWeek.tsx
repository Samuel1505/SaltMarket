import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cmd, formatMarks } from '@saltmarket/shared/client';
import type { Shock, TimelapseFrame } from '@saltmarket/shared/protocol';
import { onTimelapse, useGame } from '../../store/game';
import { act } from '../../store/act';
import { Badge, Button, Meter, Trend } from '../../ui/primitives';
import { LineChart } from '../../ui/LineChart';
import type { Good } from '../../lib/goods';
import './timelapse.css';

type Phase = 'idle' | 'starting' | 'running' | 'done' | 'stopped';
type Note = { key: string; when: string; name: string; text: string };

const DAYS = [1, 2, 3, 4, 5, 6, 7];
const TICKS_PER_DAY = 24;
const STATUS = { open: { label: '● Open', tone: 'up' }, paused: { label: '❚❚ Paused', tone: 'warn' }, closed: { label: '✕ Closed', tone: 'closed' } } as const;

/** Sandbox time from the frame's offset (frames carry the world's absolute day/hour, not the run's). */
function when(f: TimelapseFrame): string {
  const day = Math.min(7, Math.floor(Math.max(0, f.tickOffset - 1) / TICKS_PER_DAY) + 1);
  const hour = f.tickOffset === 0 ? 0 : f.tickOffset - (day - 1) * TICKS_PER_DAY;
  return `Day ${day} · ${String(hour).padStart(2, '0')}:00`;
}

/** Friendly y-axis bounds (whole marks on a 1/5/10/50 step) so the labels read cleanly. */
function niceRange(lo: number, hi: number): [number, number] {
  const span = Math.max(100, hi - lo);
  const marks = span / 100;
  const step = (marks > 200 ? 50 : marks > 40 ? 10 : marks > 8 ? 5 : 1) * 100;
  return [Math.max(0, Math.floor(lo / step) * step), Math.ceil(hi / step) * step];
}

function DaySelect({ value, onChange, label, extra }: { value: number; onChange: (v: number) => void; label: string; extra?: { value: number; label: string } }) {
  return (
    <label className="select">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {extra && <option value={extra.value}>{extra.label}</option>}
        {DAYS.map((d) => (
          <option key={d} value={d}>
            Day {d}
          </option>
        ))}
      </select>
    </label>
  );
}

function ShockSetup({ disabled, onStart }: { disabled: boolean; onStart: (shocks: Shock[]) => void }) {
  const npcs = useGame((s) => s.world?.npcs ?? []);
  const goods = useGame((s) => s.world?.catalog.goods ?? []);
  const merchants = npcs.filter((n) => n.archetype !== 'captain');
  const [storm, setStorm] = useState(true);
  const [stormDay, setStormDay] = useState(2);
  const [close, setClose] = useState(false);
  const [closeId, setCloseId] = useState('');
  const [closeDay, setCloseDay] = useState(3);
  const [investDay, setInvestDay] = useState(0); // 0 = leave it to the Town Fund
  const [flood, setFlood] = useState(false);
  const [floodGood, setFloodGood] = useState<Good>('timber');
  const [floodDay, setFloodDay] = useState(4);
  const closeTarget = merchants.find((m) => m.id === closeId) ?? merchants.find((m) => m.archetype === 'cooper') ?? merchants[0];

  function start() {
    const shocks: Shock[] = [];
    if (storm) shocks.push({ kind: 'storm', day: stormDay - 1 });
    if (close && closeTarget)
      shocks.push({ kind: 'close_merchant', npcId: closeTarget.id, day: closeDay - 1, ...(investDay > closeDay ? { investDay: investDay - 1 } : {}) });
    if (flood) shocks.push({ kind: 'flood', good: floodGood, qty: 200, day: floodDay - 1 });
    onStart(shocks);
  }

  return (
    <div className="tl-setup">
      <p className="muted tl-intro">
        Runs a copy of the town for seven days in about a minute. The live town keeps going untouched. Add a shock to see how the merchants
        react.
      </p>
      <div className="tl-shocks">
        <div className="tl-shock">
          <label className="check">
            <input type="checkbox" checked={storm} onChange={(e) => setStorm(e.target.checked)} />
            <span>Storm on</span>
          </label>
          <DaySelect value={stormDay} onChange={setStormDay} label="Storm day" />
        </div>
        <div className="tl-shock">
          <label className="check">
            <input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} />
            <span>Close</span>
          </label>
          <label className="select">
            <span className="sr-only">Merchant to close</span>
            <select value={closeTarget?.id ?? ''} onChange={(e) => setCloseId(e.target.value)}>
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.title}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">on</span>
          <DaySelect value={closeDay} onChange={setCloseDay} label="Closing day" />
          <span className="muted">reopened by</span>
          <label className="select">
            <span className="sr-only">Who reopens it</span>
            <select value={investDay} onChange={(e) => setInvestDay(Number(e.target.value))}>
              <option value={0}>the Town Fund</option>
              {DAYS.filter((d) => d > closeDay).map((d) => (
                <option key={d} value={d}>
                  an investor on day {d}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="tl-shock">
          <label className="check">
            <input type="checkbox" checked={flood} onChange={(e) => setFlood(e.target.checked)} />
            <span>Flood the market with 200</span>
          </label>
          <label className="select">
            <span className="sr-only">Good to flood</span>
            <select value={floodGood} onChange={(e) => setFloodGood(e.target.value as Good)}>
              {goods.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">on</span>
          <DaySelect value={floodDay} onChange={setFloodDay} label="Flood day" />
        </div>
      </div>
      <Button variant="primary" onClick={start} disabled={disabled}>
        Watch a week
      </Button>
    </div>
  );
}

function Charts({ frames, totalTicks }: { frames: TimelapseFrame[]; totalTicks: number }) {
  const goods = useGame((s) => s.world?.catalog.goods ?? []);
  const last = frames[frames.length - 1];
  const first = frames[0];
  const bands = useMemo(() => {
    const out: Array<[number, number]> = [];
    let prev = 0;
    for (const f of frames) {
      if (f.events.length > 0) {
        const tail = out[out.length - 1];
        if (tail && tail[1] >= prev) tail[1] = f.tickOffset;
        else out.push([prev, f.tickOffset]);
      }
      prev = f.tickOffset;
    }
    return out;
  }, [frames]);
  const xTicks = DAYS.slice(1).map((d) => (d - 1) * TICKS_PER_DAY);

  return (
    <div className="tl-charts">
      {goods.map((g) => {
        const pts = frames.map((f) => [f.tickOffset, f.prices[g.id] ?? null] as [number, number | null]);
        const isCured = g.id === 'cured_fish';
        const ceiling = isCured ? frames.map((f) => [f.tickOffset, f.captainCeilingPips] as [number, number]) : [];
        const seen = [...pts.map(([, v]) => v).filter((v): v is number => v !== null), ...ceiling.map(([, v]) => v)];
        // Fit the axis to what happened (±15% headroom) so a 10% move is visible; anchor keeps an empty chart sensible.
        const [bottom, top] = niceRange(Math.min(g.anchorPips, ...seen) * 0.85, Math.max(g.anchorPips, ...seen) * 1.15);
        const now = last?.prices[g.id] ?? null;
        const then = first?.prices[g.id] ?? null;
        const trend = now !== null && then !== null ? (now > then * 1.03 ? 'up' : now < then * 0.97 ? 'down' : 'flat') : 'flat';
        const bps = now !== null && then ? Math.round(((now - then) / then) * 10000) : 0;
        return (
          <figure key={g.id} className="tl-chart">
            <figcaption className="tl-chart-head">
              <span className="tl-chart-name">{g.name}</span>
              <span className="tl-chart-now num">
                {now !== null ? formatMarks(now) : '–'} {frames.length > 1 && <Trend trend={trend} bps={bps} />}
              </span>
            </figcaption>
            <LineChart
              label={`${g.name} price over the week${now !== null ? `, now ${formatMarks(now)} marks` : ''}`}
              xMax={totalTicks}
              yMin={bottom}
              yMax={top}
              bands={bands}
              xTicks={xTicks}
              series={[{ id: 'price', points: pts }, ...(isCured ? [{ id: 'ceiling', points: ceiling, tone: 'ceiling' as const }] : [])]}
            />
            <span className="tl-chart-axis num">
              <span>{formatMarks(bottom)}</span>
              <span>{formatMarks(top)} marks</span>
            </span>
            {isCured && (
              <span className="tl-legend">
                <span className="tl-key" data-tone="ceiling" aria-hidden="true" /> Captain pays up to{' '}
                <span className="num gold">{last ? formatMarks(last.captainCeilingPips) : '–'}</span>
              </span>
            )}
          </figure>
        );
      })}
    </div>
  );
}

function Merchants({ frames }: { frames: TimelapseFrame[] }) {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!last) return null;
  return (
    <table className="tl-merchants">
      <caption className="tl-h">Merchants</caption>
      <thead>
        <tr>
          <th scope="col">Merchant</th>
          <th scope="col">Shop</th>
          <th scope="col" className="r">
            Purse
          </th>
        </tr>
      </thead>
      <tbody>
        {last.merchants.map((m) => {
          const start = first?.merchants.find((x) => x.id === m.id)?.pursePips ?? m.pursePips;
          const d = m.pursePips - start;
          const st = STATUS[m.status];
          return (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>
                <Badge tone={st.tone}>{st.label}</Badge>
              </td>
              <td className="r num">
                {formatMarks(m.pursePips)}{' '}
                <span className={d > 0 ? 'up' : d < 0 ? 'down' : 'muted'}>
                  {d > 0 ? '▲' : d < 0 ? '▼' : '–'} {d !== 0 ? formatMarks(Math.abs(d)) : ''}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function WatchWeek() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [frames, setFrames] = useState<TimelapseFrame[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [summary, setSummary] = useState<string[]>([]);
  const [total, setTotal] = useState(168);
  const idRef = useRef<string | null>(null);
  const signedIn = useGame((s) => !!s.world?.me);

  useEffect(
    () =>
      onTimelapse((m) => {
        if (idRef.current && m.timelapseId !== idRef.current) return;
        idRef.current = m.timelapseId;
        setTotal(m.totalTicks);
        if (m.phase === 'started') setPhase('running');
        else if (m.phase === 'frame' && m.frame) {
          const f = m.frame;
          setPhase('running');
          setFrames((fs) => [...fs, f]);
          if (f.notes.length)
            setNotes((ns) => [...f.notes.map((n, i) => ({ key: `${f.tickOffset}-${i}`, when: when(f), name: n.name, text: n.text })).reverse(), ...ns].slice(0, 80));
        } else if (m.phase === 'done') {
          setPhase('done');
          setSummary(m.summary ?? []);
        } else if (m.phase === 'stopped') setPhase('stopped');
      }),
    [],
  );

  async function start(shocks: Shock[]) {
    setPhase('starting');
    setFrames([]);
    setNotes([]);
    setSummary([]);
    idRef.current = null;
    const ack = await act(cmd({ t: 'timelapse', action: 'start', shocks }), { quiet: true });
    if (!ack.ok) setPhase('idle');
    else if (ack.result?.kind === 'timelapse') idRef.current = ack.result.timelapseId;
  }
  async function stop() {
    await act(cmd({ t: 'timelapse', action: 'stop' }), { quiet: true });
    setPhase('stopped');
  }

  const last = frames[frames.length - 1];
  const running = phase === 'running' || phase === 'starting';

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={<Button size="sm" />}>{running ? 'Watching a week…' : 'Watch a week'}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog tl">
          <header className="dialog-head">
            <div>
              <Dialog.Title className="dialog-title">Watch a week</Dialog.Title>
              <Dialog.Description className="muted dialog-desc">A fast-forward of the town's economy. Nothing here touches your purse.</Dialog.Description>
            </div>
            <Dialog.Close render={<Button size="sm" variant="ghost" />}>Close</Dialog.Close>
          </header>

          {phase === 'idle' && frames.length === 0 && <ShockSetup disabled={!signedIn} onStart={start} />}
          {!signedIn && phase === 'idle' && <p className="muted tl-intro">Sign in to run a week.</p>}

          {(running || frames.length > 0) && (
            <section className="tl-run" aria-label="Time-lapse">
              <div className="tl-progress">
                <span className="num tl-when">{last ? when(last) : 'Setting sail…'}</span>
                <Meter value={last?.tickOffset ?? 0} max={total} label={`Time-lapse progress, ${last?.tickOffset ?? 0} of ${total} hours`} />
                {running && (
                  <Button size="sm" onClick={stop}>
                    Stop
                  </Button>
                )}
                {last && last.events.length > 0 && <Badge tone="warn">{last.events.join(', ').replace(/_/g, ' ')}</Badge>}
              </div>
              {summary.length > 0 && (
                <div className="tl-summary" role="status">
                  <h3 className="tl-h">How the week went</h3>
                  <ul>
                    {summary.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Charts frames={frames} totalTicks={total} />
              <div className="tl-lower">
                <Merchants frames={frames} />
                <div className="tl-notes">
                  <h3 className="tl-h">Why prices moved</h3>
                  <ol className="tl-note-list">
                    {notes.length === 0 && <li className="muted">Reasons appear here as merchants decide.</li>}
                    {notes.map((n) => (
                      <li key={n.key}>
                        <span className="muted num tl-note-when">{n.when}</span> <strong>{n.name}</strong>: {n.text}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>
          )}
          {(phase === 'done' || phase === 'stopped') && (
            <section className="tl-again" aria-label="Run another week">
              <h3 className="tl-h">Run another week</h3>
              <ShockSetup disabled={!signedIn} onStart={start} />
            </section>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
