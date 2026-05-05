"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useAgentWallet } from "@/lib/hooks/useAgentWallet";
import { useRefundClaimer } from "@/lib/hooks/useRefundClaimer";
import { buildDepositIx, buildClaimRefundIx } from "@/lib/solana";
import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatUsdcShort, formatRelativeTime } from "@/lib/format";
import type { AgentWalletState } from "@/lib/api";

interface AgentWalletPanelProps {
  pubkey: string;
  initialState: AgentWalletState;
}

export function AgentWalletPanel({ pubkey, initialState }: AgentWalletPanelProps) {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { walletState, loading, error, refresh } = useAgentWallet(pubkey);
  const state = walletState ?? initialState;

  // TODO(wave2-integration): replace stub with real @solana/web3.js Transaction + Codama ix
  async function handleClaim() {
    if (!publicKey) return;
    const _ix = buildClaimRefundIx(pubkey);
    // Stub: log instruction; real impl sends transaction via sendTransaction
    console.log("claim_refund stub ix", _ix);
    refresh();
  }

  useRefundClaimer({
    pubkey,
    pendingRefund: state.pendingRefund,
    onClaim: handleClaim,
  });

  // TODO(wave2-integration): replace stub with real deposit_usdc transaction
  async function handleDeposit() {
    if (!publicKey) return;
    const _ix = buildDepositIx(pubkey, 5_000_000);
    console.log("deposit_usdc stub ix", _ix);
    refresh();
  }

  async function handleAirdrop() {
    // Request 1 SOL airdrop on devnet, then open Circle USDC faucet
    try {
      const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
      await fetch(`${rpc}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "requestAirdrop",
          params: [pubkey, 1_000_000_000],
        }),
      });
    } catch (_) {
      // non-fatal — user may not need SOL airdrop
    }
    window.open("https://faucet.circle.com", "_blank", "noopener");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader><CardTitle>Balance</CardTitle></CardHeader>
          <CardValue>{formatUsdcShort(state.balance)}</CardValue>
        </Card>
        <Card>
          <CardHeader><CardTitle>Pending Refund</CardTitle></CardHeader>
          <CardValue className={state.pendingRefund > 0 ? "text-[#C9553D]" : "text-[#f5f0eb]"}>
            {formatUsdcShort(state.pendingRefund)}
          </CardValue>
        </Card>
        <Card>
          <CardHeader><CardTitle>Premiums Paid</CardTitle></CardHeader>
          <CardValue className="text-[#B87333]">{formatUsdcShort(state.totalPremiumsPaid)}</CardValue>
        </Card>
        <Card>
          <CardHeader><CardTitle>Refunds Claimed</CardTitle></CardHeader>
          <CardValue className="text-[#5A6B7A]">{formatUsdcShort(state.totalRefundsClaimed)}</CardValue>
        </Card>
      </div>

      {error && (
        <div className="text-sm text-[#C9553D] font-mono border border-[#C9553D] px-3 py-2">
          RPC error: {error}
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        {connected && publicKey?.toBase58() === pubkey ? (
          <>
            <Button variant="copper" onClick={handleDeposit}>
              Deposit 5 USDC
            </Button>
            {state.pendingRefund > 0 && (
              <Button variant="sienna" onClick={handleClaim}>
                Claim {formatUsdcShort(state.pendingRefund)} Refund
              </Button>
            )}
            <Button variant="ghost" onClick={handleAirdrop}>
              Get devnet USDC
            </Button>
          </>
        ) : (
          <p className="text-sm text-[#8a7a70]">
            Connect wallet matching this agent pubkey to deposit or claim.
          </p>
        )}
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      {state.lastActivity && (
        <p className="text-xs text-[#8a7a70]">
          Last activity: {formatRelativeTime(state.lastActivity)}
        </p>
      )}
    </div>
  );
}
