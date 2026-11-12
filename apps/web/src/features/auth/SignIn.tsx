import { lazy, Suspense, useCallback, useState, type FormEvent } from 'react';
import { loginGuest, type Result } from '../../lib/api';
import type { Session } from '@saltmarket/shared/protocol';
import { saveSession } from '../../lib/session';
import { connect, useGame } from '../../store/game';
import { Button, Card } from '../../ui/primitives';
import './auth.css';

// Public app id (not a secret). Without it, the social button is hidden and guest play still works.
const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID || undefined;
const PrivyLogin = lazy(() => import('./PrivyLogin'));

function begin(session: Session) {
  saveSession(session);
  useGame.setState({ sessionExpired: false });
  connect();
}

export function SignIn() {
  const expired = useGame((s) => s.sessionExpired);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [social, setSocial] = useState(false);

  const onSocialDone = useCallback((r: Result<Session> | { ok: false; code: 'CANCELLED'; message: string }) => {
    setSocial(false);
    if (r.ok) begin(r.data);
    else if (r.code === 'SOCIAL_UNAVAILABLE') setError('Email sign-in is resting right now. Play as a guest instead.');
    else if (r.code !== 'CANCELLED') setError(r.message);
  }, []);

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
    begin(r.data);
  }

  return (
    <Card className="signin" title="Open a stall at the harbor">
      <p className="muted">
        Gather fish, salt and timber, sell to the town's merchants, and cure fish for the ship. You start with a purse of marks.
      </p>
      {expired && <p className="signin-note">You were signed out. Open your stall again to keep playing.</p>}
      {PRIVY_APP_ID && (
        <>
          <Button
            variant="primary"
            className="signin-social"
            disabled={social || busy}
            onClick={() => {
              setError(null);
              setSocial(true);
            }}
          >
            {social ? 'Opening sign-in…' : 'Continue with email or Google'}
          </Button>
          <p className="signin-or muted" aria-hidden="true">
            or
          </p>
        </>
      )}
      {social && PRIVY_APP_ID && (
        <Suspense fallback={null}>
          <PrivyLogin appId={PRIVY_APP_ID} displayName={name.trim() || undefined} onDone={onSocialDone} />
        </Suspense>
      )}
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
        <Button type="submit" variant={PRIVY_APP_ID ? 'ghost' : 'primary'} disabled={busy || social}>
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
