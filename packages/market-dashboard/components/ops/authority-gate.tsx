"use client";

/**
 * Sticky header for /ops/* — reads on-chain ProtocolConfig.authority once and
 * displays a sienna mismatch banner when the connected wallet's pubkey
 * differs. Submit buttons across all ops pages call useAuthorityState() to
 * gate themselves; this component owns the source of truth.
 *
 * Hydration-safe: renders a neutral skeleton during SSR and the "loading"
 * state on initial client render so server and client HTML match (no
 * "checking authority…" banner that flashes on the server then disconnects
 * on the client — that would log a hydration warning).
 */

import { createContext, useContext, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getOperator, CLUSTER } from "@/lib/ops/operator";

export type AuthorityState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "match"; expected: PublicKey }
  | { phase: "mismatch"; expected: PublicKey; connected: PublicKey }
  | { phase: "error"; error: string };

const AuthorityContext = createContext<AuthorityState>({ phase: "idle" });

export function useAuthorityState(): AuthorityState {
  return useContext(AuthorityContext);
}

/** True when the connected wallet matches ProtocolConfig.authority. */
export function useIsAuthority(): boolean {
  const s = useAuthorityState();
  return s.phase === "match";
}

interface Props {
  children: React.ReactNode;
}

export function OpsAuthorityGate({ children }: Props) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [state, setState] = useState<AuthorityState>({ phase: "idle" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!publicKey) {
      setState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const expected = await getOperator(connection).getProtocolAuthority();
        if (cancelled) return;
        if (expected.equals(publicKey)) {
          setState({ phase: "match", expected });
        } else {
          setState({ phase: "mismatch", expected, connected: publicKey });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          phase: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, reloadKey]);

  return (
    <AuthorityContext.Provider value={state}>
      <div className="space-y-4">
        <Banner state={state} onRetry={() => setReloadKey((k) => k + 1)} />
        {children}
      </div>
    </AuthorityContext.Provider>
  );
}

function Banner({
  state,
  onRetry,
}: {
  state: AuthorityState;
  onRetry: () => void;
}) {
  if (state.phase === "idle") {
    return (
      <div className="border border-[#2a2420] p-4 text-sm font-mono text-[#8a7a70]">
        Connect a wallet to use the operator console ({CLUSTER}).
      </div>
    );
  }
  if (state.phase === "loading") {
    return (
      <div className="border border-[#2a2420] p-4 text-sm font-mono text-[#8a7a70]">
        Checking on-chain ProtocolConfig.authority…
      </div>
    );
  }
  if (state.phase === "match") {
    return (
      <div className="border border-[#2a2420] p-4 text-sm font-mono text-[#5A6B7A]">
        Authority OK — connected wallet matches ProtocolConfig.authority on {CLUSTER}.
      </div>
    );
  }
  if (state.phase === "mismatch") {
    return (
      <div className="border-2 border-[#C9553D] p-4 text-sm font-mono text-[#f5f0eb] bg-[#2a1a18]">
        <div className="font-bold text-[#C9553D] mb-2">
          Authority mismatch — submit disabled on /ops/* (except /ops/topup, which uses a per-pool authority)
        </div>
        <div className="text-xs text-[#8a7a70]">
          Expected (on-chain ProtocolConfig.authority):
        </div>
        <div className="break-all">{state.expected.toBase58()}</div>
        <div className="mt-2 text-xs text-[#8a7a70]">Connected wallet:</div>
        <div className="break-all">{state.connected.toBase58()}</div>
        <div className="mt-2 text-xs">
          Disconnect via the wallet button in the top-right and connect the
          authority key to proceed.
        </div>
      </div>
    );
  }
  // phase === "error"
  return (
    <div className="border border-[#C9553D] p-4 text-sm font-mono text-[#f5f0eb]">
      <div className="font-bold text-[#C9553D] mb-2">
        RPC error reading ProtocolConfig
      </div>
      <div className="text-xs">{state.error}</div>
      <button
        onClick={onRetry}
        className="mt-2 px-3 py-1 border border-[#2a2420] hover:bg-[#2a2420] text-xs"
      >
        Retry preflight
      </button>
    </div>
  );
}
