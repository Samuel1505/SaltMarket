// Loaded lazily (React.lazy) so the Privy SDK only downloads when someone picks email/social sign-in.
// The game never uses Privy's embedded wallet: creation is off and only email + Google are offered.
import { useEffect, useRef } from 'react';
import { PrivyProvider, useLogin, usePrivy } from '@privy-io/react-auth';
import { loginSocial, type Result } from '../../lib/api';
import type { Session } from '@saltmarket/shared/protocol';

type Props = {
  appId: string;
  displayName?: string;
  onDone: (r: Result<Session> | { ok: false; code: 'CANCELLED'; message: string }) => void;
};

/** Reads a color token at runtime so the Privy modal matches our theme without a raw color in this file. */
function token(name: string): `#${string}` | undefined {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.startsWith('#') ? (v as `#${string}`) : undefined;
}

function Flow({ displayName, onDone }: Omit<Props, 'appId'>) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const started = useRef(false);
  const exchanged = useRef(false);

  const exchange = async () => {
    if (exchanged.current) return;
    exchanged.current = true;
    const credential = await getAccessToken();
    if (!credential) {
      onDone({ ok: false, code: 'BAD_CREDENTIAL', message: 'Sign-in expired. Please try again.' });
      return;
    }
    onDone(await loginSocial(credential, displayName));
  };

  const { login } = useLogin({
    onComplete: () => void exchange(),
    // Closing the dialog is not an error to the player: just re-enable the buttons.
    onError: (code) =>
      onDone(
        code === 'exited_auth_flow'
          ? { ok: false, code: 'CANCELLED', message: '' }
          : { ok: false, code: 'BAD_CREDENTIAL', message: "Couldn't sign you in. Try again, or play as a guest." },
      ),
  });

  // Already signed in with Privy (e.g. after the server forgot our session): exchange without a dialog.
  // Otherwise open the Privy dialog once.
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    if (authenticated) void exchange();
    else login();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when Privy becomes ready
  }, [ready]);

  return null;
}

export default function PrivyLogin({ appId, displayName, onDone }: Props) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'google'],
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } },
        appearance: {
          theme: 'dark', // the game has one dark theme
          accentColor: token('--accent'),
          landingHeader: 'Open a stall at the harbor',
          loginMessage: 'Sign in to keep your stall between visits.',
        },
      }}
    >
      <Flow displayName={displayName} onDone={onDone} />
    </PrivyProvider>
  );
}
