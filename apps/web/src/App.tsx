import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { connect, useGame } from './store/game';
import { TopBar, EventBanner, ConnectionBanner } from './features/town/TopBar';
import { GatherPanel } from './features/gather/GatherPanel';
import { MarketPanel } from './features/market/MarketPanel';
import { NpcCards } from './features/npcs/NpcCards';
import { StallPanel } from './features/stall/StallPanel';
import { ShipPanel } from './features/ship/ShipPanel';
import { SignIn } from './features/auth/SignIn';
import { hold } from './styles/tokens.motion';
import './app.css';

export function App() {
  const hasWorld = useGame((s) => s.world !== null);
  const signedIn = useGame((s) => s.world?.me != null);
  const storm = useGame((s) => s.world?.events.some((e) => e.kind === 'storm') ?? false);

  useEffect(() => {
    connect();
  }, []);

  return (
    <div className="app" data-storm={storm}>
      <TopBar />
      <main className="main">
        <ConnectionBanner />
        <EventBanner />
        {!hasWorld ? (
          <p className="loading muted" role="status">
            Walking down to the harbor…
          </p>
        ) : (
          <div className="layout">
            <div className="col">
              {signedIn ? <GatherPanel /> : <SignIn />}
              {signedIn && <StallPanel />}
              <MarketPanel />
            </div>
            <div className="col">
              <ShipPanel />
              <NpcCards />
            </div>
          </div>
        )}
      </main>
      <Toaster
        position="bottom-center"
        visibleToasts={3}
        duration={hold.toast}
        toastOptions={{ unstyled: false, classNames: { toast: 'toast' } }}
      />
    </div>
  );
}
