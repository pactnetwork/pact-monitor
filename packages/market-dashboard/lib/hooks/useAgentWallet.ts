"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchAgent } from "@/lib/api";
import type { AgentWalletState } from "@/lib/api";

interface UseAgentWalletResult {
  walletState: AgentWalletState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 5_000;

export function useAgentWallet(pubkey: string | null): UseAgentWalletResult {
  const [walletState, setWalletState] = useState<AgentWalletState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!pubkey) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgent(pubkey);
      setWalletState(data.agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWalletState(null);
    } finally {
      setLoading(false);
    }
  }, [pubkey]);

  useEffect(() => {
    if (!pubkey) {
      setWalletState(null);
      setLoading(false);
      setError(null);
      return;
    }
    fetch();
    const id = setInterval(fetch, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pubkey, fetch]);

  return { walletState, loading, error, refresh: fetch };
}
