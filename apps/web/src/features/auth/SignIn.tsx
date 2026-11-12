import { useState, type FormEvent } from 'react';
import { loginGuest } from '../../lib/api';
import { saveSession } from '../../lib/session';
import { connect, useGame } from '../../store/game';
import { Button, Card } from '../../ui/primitives';
import './auth.css';

export function SignIn() {
  const expired = useGame((s) => s.sessionExpired);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await loginGuest(name.trim() || undefined);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    saveSession(r.data);
    useGame.setState({ sessionExpired: false });
    connect();
  }

  return (
    <Card className="signin" title="Open a stall at the harbor">
      <p className="muted">
        Gather fish, salt and timber, sell to the town's merchants, and cure fish for the ship. You start with a purse of marks.
      </p>
      {expired && <p className="signin-note">You were signed out. Open your stall again to keep playing.</p>}
      <form onSubmit={submit} className="signin-form">
        <label className="signin-label">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            placeholder="e.g. Mira"
            autoComplete="nickname"
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Opening…' : 'Play as guest'}
        </Button>
      </form>
      {error && (
        <p className="signin-error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
