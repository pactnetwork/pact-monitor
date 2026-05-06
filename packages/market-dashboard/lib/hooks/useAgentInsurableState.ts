"use client";

/**
 * `useAgentInsurableState` — subscribes to an agent's USDC ATA balance + SPL
 * Token delegate state and reports whether the on-chain program will accept
 * the next settle_batch debit.
 *
 * Replaces the old `useAgentWallet` hook. The previous design polled an
 * `AgentWallet` PDA owned by the protocol; in the Step C / Phase 0 layered
 * model agents hold USDC in their own ATA and grant SPL Token approval to the
 * SettlementAuthority PDA, so we inspect the ATA directly via RPC.
 *
 * Returns the same `BalanceCheckResult`-shaped object emitted by
 * `@pact-network/wrap`'s preflight check: `{ ataBalance, allowance, eligible,
 * reason? }`. The dashboard banners feed off `eligible === false` to prompt a
 * re-approve.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAgentInsurableState,
  USDC_MINT_DEVNET,
  PROGRAM_ID,
  getSettlementAuthorityPda,
  type AgentInsurableState,
} from "@pact-network/protocol-v1-client";

import { SOLANA_RPC } from "../solana";

const POLL_INTERVAL_MS = 5_000;
/** Minimum premium (matches MIN_PREMIUM_LAMPORTS in the program). */
const MIN_PREMIUM = 100n;

export interface BalanceCheckResult {
  ataBalance: bigint;
  allowance: bigint;
  eligible: boolean;
  reason?: string;
}

export interface UseAgentInsurableStateResult {
  state: BalanceCheckResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Optional override hook for tests — supplies a mock state inspector. The
 * runtime path uses `getAgentInsurableState` from protocol-v1-client.
 */
export type InsurableInspector = (
  agentOwner: PublicKey
) => Promise<AgentInsurableState>;

function defaultInspector(connection: Connection): InsurableInspector {
  const [settlementPda] = getSettlementAuthorityPda(PROGRAM_ID);
  return (agentOwner: PublicKey) =>
    getAgentInsurableState(
      connection,
      agentOwner,
      USDC_MINT_DEVNET,
      settlementPda,
      MIN_PREMIUM
    );
}

export function useAgentInsurableState(
  pubkey: string | null,
  inspectorOverride?: InsurableInspector
): UseAgentInsurableStateResult {
  const [state, setState] = useState<BalanceCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stash the inspector so the polling effect doesn't re-create it each tick.
  const inspectorRef = useRef<InsurableInspector | null>(null);

  const ensureInspector = useCallback((): InsurableInspector => {
    if (inspectorOverride) return inspectorOverride;
    if (!inspectorRef.current) {
      inspectorRef.current = defaultInspector(
        new Connection(SOLANA_RPC, "confirmed")
      );
    }
    return inspectorRef.current;
  }, [inspectorOverride]);

  const fetchOnce = useCallback(async () => {
    if (!pubkey) return;
    setLoading(true);
    setError(null);
    try {
      const inspector = ensureInspector();
      const result = await inspector(new PublicKey(pubkey));
      setState({
        ataBalance: result.ataBalance,
        allowance: result.allowance,
        eligible: result.eligible,
        reason: result.reason,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [pubkey, ensureInspector]);

  useEffect(() => {
    if (!pubkey) {
      setState(null);
      setLoading(false);
      setError(null);
      return;
    }
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pubkey, fetchOnce]);

  return { state, loading, error, refresh: fetchOnce };
}
