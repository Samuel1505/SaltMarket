import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { connect, useGame } from './store/game';
import { TopBar, EventBanner, ConnectionBanner } from './features/town/TopBar';
import { GatherPanel } from './features/gather/GatherPanel';
import { MarketPanel } from './features/market/MarketPanel';
import { NpcCards } from './features/npcs/NpcCards';
import { StallPanel } from './features/stall/StallPanel';
import { ShipPanel } from './features/ship/ShipPanel';
import { HallsPanel } from './features/halls/HallsPanel';
import { FeedPanel, useFeedToasts } from './features/feed/FeedPanel';
import { Leaderboard } from './features/leaderboard/Leaderboard';
import { JudgePanel } from './features/judge/JudgePanel';
import { LedgerDrawer } from './features/judge/LedgerDrawer';
import { JUDGE } from './lib/judge';
import { SignIn } from './features/auth/SignIn';
import { hold } from './styles/tokens.motion';
import { DevToggle } from './dev/DevToggle';
import './dev/dev.css';
import './app.css';

type Tab = 'stall' | 'market' | 'npcs' | 'news';
const TABS: Array<[Tab, string]> = [
  ['stall', 'Stall'],
  ['market', 'Market'],
  ['npcs', 'Merchants'],
  ['news', 'News'],
];

export function App() {
  const hasWorld = useGame((s) => s.world !== null);
  const signedIn = useGame((s) => s.world?.me != null);
  const storm = useGame((s) => s.world?.events.some((e) => e.kind === 'storm') ?? false);

  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('stall');
  useFeedToasts();

  useEffect(() => {
    connect();
  }, []);

  return (
    <div className="app" data-storm={storm}>
      <TopBar />
      {JUDGE && hasWorld && <JudgePanel onOpenLedger={() => setLedgerOpen(true)} />}
      <main className="main">
        <ConnectionBanner />
        <EventBanner />
        {!hasWorld ? (
          <p className="loading muted" role="status">
            Walking down to the harbor…
          </p>
        ) : (
          <>
            <nav className="tabs" aria-label="Sections">
              {TABS.map(([id, label]) => (
                <button key={id} type="button" className="tab" aria-pressed={tab === id} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </nav>
            {/* Desktop: stall | market | merchants, news along the bottom. Phones: one section at a time (all stay mounted). */}
            <div className="layout" data-tab={tab}>
              <div className="col col-stall" data-section="stall">
                {signedIn ? <GatherPanel /> : <SignIn />}
                {signedIn && <StallPanel />}
              </div>
              <div className="col col-market" data-section="market">
                <ShipPanel />
                <MarketPanel />
                <HallsPanel />
              </div>
              <div className="col col-npcs" data-section="npcs">
                <NpcCards />
              </div>
              <div className="col col-news" data-section="news">
                <FeedPanel />
                <Leaderboard />
              </div>
            </div>
          </>
        )}
      </main>
      {JUDGE && <LedgerDrawer open={ledgerOpen} onOpenChange={setLedgerOpen} />}
      {import.meta.env.DEV && <DevToggle />}
      <Toaster
        position="bottom-right"
        offset={16}
        mobileOffset={{ bottom: 72 }}
        visibleToasts={3}
        duration={hold.toast}
        toastOptions={{ unstyled: false, classNames: { toast: 'toast' } }}
      />
    </div>
  );
}
