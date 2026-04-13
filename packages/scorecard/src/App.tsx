import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { ProviderTable } from "./components/ProviderTable";
import { ProviderDetail } from "./components/ProviderDetail";
import { AdminDashboard } from "./components/AdminDashboard";
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
    <BrowserRouter>
      <PageTracker />
      <div className="min-h-screen bg-bg">
        <header className="border-b border-border px-8 py-4">
          <h1 className="font-serif text-xl text-neutral-200 tracking-wide">
            Pact Network
          </h1>
          <p className="text-sm text-neutral-500 font-sans">
            API Reliability Scorecard
          </p>
        </header>
        <main className="px-8 py-6">
          <Routes>
            <Route path="/" element={<ProviderTable />} />
            <Route path="/provider/:id" element={<ProviderDetail />} />
            <Route path="/admin" element={<AdminDashboard />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
