"use client";

/**
 * Agent approval panel — replaces the old deposit/withdraw UX.
 *
 * The dashboard no longer manages an `AgentWallet` PDA. Agents hold USDC in
 * their own SPL Token ATA and grant `Approve` to the SettlementAuthority PDA
 * so the program can pull premiums during settle_batch. This panel exposes
 * three buttons:
 *
 *   1. **Approve** — sets the delegate + allowance (default 25 USDC).
 *   2. **Re-approve** — same builder; surfaces when the allowance falls below
 *      the program's `min_premium`.
 *   3. **Revoke** — clears the delegate. Confirmed via window.confirm so a
 *      misclick can't sever a working integration.
 *
 * A separate "Get devnet USDC" button is kept (Circle faucet + 1 SOL air drop
 * for tx fees). The component still polls the agent's on-chain ATA every 5s
 * via `useAgentInsurableState` and shows balance/allowance/eligibility.
 */

import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";

import { useAgentInsurableState } from "@/lib/hooks/useAgentInsurableState";
import {
  buildApproveTransaction,
  buildRevokeTransaction,
  DEFAULT_APPROVE_LAMPORTS,
} from "@/lib/solana";
import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatUsdcShort, formatRelativeTime } from "@/lib/format";
import type { AgentInsurableSnapshot } from "@/lib/api";

// Mirrors the program's MIN_PREMIUM_LAMPORTS (also exported by the SDK).
const MIN_PREMIUM_LAMPORTS = 100n;

interface AgentApprovalPanelProps {
  pubkey: string;
  initialState: AgentInsurableSnapshot;
}

export function AgentApprovalPanel({
  pubkey,
  initialState,
}: AgentApprovalPanelProps) {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const { state, loading, error, refresh } = useAgentInsurableState(pubkey);
  const [busy, setBusy] = useState<"approve" | "revoke" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const ataBalance = state?.ataBalance ?? BigInt(initialState.ataBalance);
  const allowance = state?.allowance ?? BigInt(initialState.allowance);
  const eligible = state?.eligible ?? initialState.eligible;
  const reason = state?.reason ?? initialState.reason;

  const isOwnedWallet = connected && publicKey?.toBase58() === pubkey;
  const allowanceBelowMin = allowance < MIN_PREMIUM_LAMPORTS;

  async function handleApprove() {
    if (!publicKey || !isOwnedWallet) return;
    setBusy("approve");
    setActionError(null);
    try {
      const tx = buildApproveTransaction(publicKey, DEFAULT_APPROVE_LAMPORTS);
      await sendTransaction(tx, connection);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke() {
    if (!publicKey || !isOwnedWallet) return;
    if (
      !window.confirm(
        "Revoking will block all future Pact-insured calls until you Approve again. Continue?"
      )
    )
      return;
    setBusy("revoke");
    setActionError(null);
    try {
      const tx = buildRevokeTransaction(publicKey);
      await sendTransaction(tx, connection);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleAirdrop() {
    try {
      const rpc =
        process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
      await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "requestAirdrop",
          params: [pubkey, 1_000_000_000],
        }),
      });
    } catch {
      /* airdrop is best-effort */
    }
    window.open("https://faucet.circle.com", "_blank", "noopener");
  }

  return (
    <div className="space-y-4">
      {!eligible && (
        <div
          role="alert"
          className="border border-[#C9553D] px-3 py-2 text-sm text-[#C9553D] font-mono"
        >
          {allowanceBelowMin
            ? "Approval used up — re-approve to keep making insured calls"
            : reason ?? "Agent is not currently insurable"}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>ATA Balance</CardTitle>
          </CardHeader>
          <CardValue>{formatUsdcShort(Number(ataBalance))}</CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Allowance</CardTitle>
          </CardHeader>
          <CardValue
            className={allowanceBelowMin ? "text-[#C9553D]" : "text-[#B87333]"}
          >
            {formatUsdcShort(Number(allowance))}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Premiums Paid</CardTitle>
          </CardHeader>
          <CardValue className="text-[#B87333]">
            {formatUsdcShort(initialState.totalPremiumsPaid)}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Refunds Received</CardTitle>
          </CardHeader>
          <CardValue className="text-[#5A6B7A]">
            {formatUsdcShort(initialState.totalRefundsReceived)}
          </CardValue>
        </Card>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-[#8a7a70]">Insurable status:</span>
        <Badge variant={eligible ? "ok" : "error"}>
          {eligible ? "active" : "expired"}
        </Badge>
      </div>

      {(error || actionError) && (
        <div className="text-sm text-[#C9553D] font-mono border border-[#C9553D] px-3 py-2">
          {actionError ? `Tx error: ${actionError}` : `RPC error: ${error}`}
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        {isOwnedWallet ? (
          <>
            <Button
              variant="copper"
              onClick={handleApprove}
              disabled={busy !== null}
              aria-label={allowanceBelowMin ? "Re-approve" : "Approve"}
            >
              {busy === "approve"
                ? allowanceBelowMin
                  ? "Re-approving..."
                  : "Approving..."
                : allowanceBelowMin
                ? "Re-approve 25 USDC"
                : "Approve 25 USDC"}
            </Button>
            <Button
              variant="sienna"
              onClick={handleRevoke}
              disabled={busy !== null || allowance === 0n}
            >
              {busy === "revoke" ? "Revoking..." : "Revoke"}
            </Button>
            <Button variant="ghost" onClick={handleAirdrop}>
              Get devnet USDC
            </Button>
          </>
        ) : (
          <p className="text-sm text-[#8a7a70]">
            Connect the wallet matching this agent pubkey to Approve or Revoke.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      {initialState.lastActivity && (
        <p className="text-xs text-[#8a7a70]">
          Last activity: {formatRelativeTime(initialState.lastActivity)}
        </p>
      )}
    </div>
  );
}
