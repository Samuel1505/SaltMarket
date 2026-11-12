import { useEffect, useState } from 'react';
import { formatMarks } from '@saltmarket/shared/client';
import { LeaderboardResponse, type Leaderboard as Board } from '@saltmarket/shared/protocol';
import { api } from '../../lib/api';
import { devBoard } from '../../dev/fixtures';
import { useGame } from '../../store/game';
import { Card } from '../../ui/primitives';
import './leaderboard.css';

const POLL_MS = 15000;
const TOP = 5;

function Rows({ rows, empty }: { rows: Board['netWorth']; empty: string }) {
  if (rows.length === 0) return <p className="muted lb-empty">{empty}</p>;
  const top = rows.slice(0, TOP);
  const me = rows.find((r) => r.isMe && r.rank > TOP);
  return (
    <ol className="lb-list">
      {[...top, ...(me ? [me] : [])].map((r) => (
        <li key={r.playerId} className="lb-row" data-me={r.isMe}>
          <span className="lb-rank num">{r.rank}</span>
          <span className="lb-who">
            <span className="lb-name" title={r.displayName}>
              {r.displayName}
            </span>
            {r.isMe && <span className="lb-you">you</span>}
          </span>
          <span className="lb-value num">{formatMarks(r.valuePips)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Richest traders and the best-earning Hall owners, refreshed every 15 s. */
export function Leaderboard() {
  const [board, setBoard] = useState<Board | null>(null);
  const signedIn = useGame((s) => !!s.world?.me);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = await api('/api/leaderboard', LeaderboardResponse);
      if (live && r.ok) setBoard(devBoard(r.data));
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [signedIn]);
  if (!board) return null;
  return (
    <Card title="Leaderboard" hint="In marks" className="lb">
      <div className="lb-cols">
        <section>
          <h3 className="lb-h">Richest traders</h3>
          <Rows rows={board.netWorth} empty="No traders yet." />
        </section>
        <section>
          <h3 className="lb-h">Hall income</h3>
          <Rows rows={board.hallIncome} empty="No Hall has earned yet." />
        </section>
      </div>
    </Card>
  );
}
