import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation, Link } from "react-router-dom";
import { ProviderTable } from "./components/ProviderTable";
import { ProviderDetail } from "./components/ProviderDetail";
import { PoolDetail } from "./components/PoolDetail";
import { ThemeToggle } from "./components/ThemeToggle";
import { AdminDashboard } from "./components/AdminDashboard";
import { FaucetPage } from "./components/FaucetPage";
import { track } from "./analytics/tracker";

function PageTracker() {
  const location = useLocation();

  useEffect(() => {
    track("page_view", { path: location.pathname });
  }, [location.pathname]);

  return null;
}

export function App() {
  useEffect(() => {
    track("session_start");
  }, []);

  return (
    <BrowserRouter basename="/scorecard">
      <PageTracker />
      <div className="min-h-screen bg-bg">
        <header className="border-b border-border px-8 py-4 flex items-center justify-between">
          <div>
            <Link to="/" className="no-underline">
              <h1 className="font-serif text-xl text-primary tracking-wide">
                Pact Network
              </h1>
              <p className="text-sm text-secondary font-sans">
                API Reliability Scorecard
              </p>
            </Link>
          </div>
          <div className="flex items-center gap-6">
            <nav className="flex gap-4 font-mono text-xs uppercase tracking-widest">
              <Link to="/" className="text-secondary hover:text-primary">Rankings</Link>
              <Link to="/faucet" className="text-secondary hover:text-primary">Faucet</Link>
            </nav>
            <ThemeToggle />
          </div>
        </header>
        <main className="px-8 py-6">
          <Routes>
            <Route path="/" element={<ProviderTable />} />
            <Route path="/provider/:id" element={<ProviderDetail />} />
            <Route path="/pool/:hostname" element={<PoolDetail />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/faucet" element={<FaucetPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
