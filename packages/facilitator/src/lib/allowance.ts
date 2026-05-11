// Agent allowance check.
//
// Before publishing a settlement event for a covered call, the facilitator
// confirms the agent has a sufficient `pact approve` allowance (SPL Token
// `Approve` → delegate = SettlementAuthority PDA) AND USDC balance to cover
// the premium — identical to the gateway path's preflight (see
// packages/market-proxy/src/lib/balance.ts). No allowance → the call is
// `uncovered` (no premium charged, no refund); the receipt is still recorded
// for analytics.
//
// We reuse `createDefaultBalanceCheck` from @pact-network/wrap (plain Solana
// JSON-RPC over fetch, short TTL cache) and supply a production ATA resolver
// via @solana/web3.js + @solana/spl-token (loaded lazily so tests that inject
// a stub resolver don't pay the cost).

import {
  createDefaultBalanceCheck,
  type BalanceCheck,
} from "@pact-network/wrap";

export interface AllowanceCheckOptions {
  rpcUrl: string;
  /** USDC mint pubkey for this network. */
  usdcMint: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Optional cache TTL override (default = wrap default, 3s). */
  cacheTtlMs?: number;
  /** Optional injected ATA resolver (tests). */
  resolveAta?: (walletPubkey: string) => string | Promise<string>;
}

export function createAllowanceCheck(opts: AllowanceCheckOptions): BalanceCheck {
  const resolveAta = opts.resolveAta ?? buildProductionResolver(opts.usdcMint);
  return createDefaultBalanceCheck({
    rpcUrl: opts.rpcUrl,
    fetchImpl: opts.fetchImpl,
    cacheTtlMs: opts.cacheTtlMs,
    resolveAta,
  });
}

function buildProductionResolver(
  usdcMint: string,
): (walletPubkey: string) => Promise<string> {
  return async (walletPubkey: string): Promise<string> => {
    const [{ PublicKey }, { getAssociatedTokenAddressSync }] = await Promise.all([
      import("@solana/web3.js"),
      import("@solana/spl-token"),
    ]);
    const owner = new PublicKey(walletPubkey);
    const mint = new PublicKey(usdcMint);
    return getAssociatedTokenAddressSync(mint, owner).toBase58();
  };
}
