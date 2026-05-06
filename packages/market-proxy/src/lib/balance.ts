// Agent custody / balance check.
//
// In the new layered model the proxy does NOT read a Pact-owned `AgentWallet`
// PDA. Instead it reads the agent's USDC associated token account (ATA)
// directly via Solana RPC and confirms two things:
//
//   1. ATA balance >= required premium (the agent has the funds), AND
//   2. SPL Token `delegated_amount` >= required premium (the agent has
//      approved Pact's settlement authority to debit at least that much).
//
// Both conditions are needed: a balance with no allowance is uncollectable;
// an allowance with no balance is uncashable. Either failure surfaces as a
// 402 Payment Required, which wrap composes for us.
//
// We delegate the work to `createDefaultBalanceCheck` from
// @pact-network/wrap, which speaks plain Solana JSON-RPC over fetch and
// caches results for 30s. The proxy supplies the `resolveAta` helper using
// @solana/web3.js + @solana/spl-token (already in the monorepo).

import {
  createDefaultBalanceCheck,
  type BalanceCheck,
} from "@pact-network/wrap";

export interface BalanceCheckOptions {
  /** Solana JSON-RPC endpoint URL. */
  rpcUrl: string;
  /** USDC mint pubkey for this network (mainnet/devnet differ). */
  usdcMint: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Optional cache TTL override (default 30s, matches wrap default). */
  cacheTtlMs?: number;
  /**
   * Optional injected ATA resolver — primarily for tests. When omitted,
   * the production resolver loads `@solana/web3.js` + `@solana/spl-token`
   * lazily and computes the canonical ATA.
   */
  resolveAta?: (walletPubkey: string) => string | Promise<string>;
}

export function createBalanceCheck(opts: BalanceCheckOptions): BalanceCheck {
  const resolveAta =
    opts.resolveAta ?? buildProductionResolver(opts.usdcMint);
  return createDefaultBalanceCheck({
    rpcUrl: opts.rpcUrl,
    fetchImpl: opts.fetchImpl,
    cacheTtlMs: opts.cacheTtlMs,
    resolveAta,
  });
}

/**
 * Lazy resolver that uses @solana/web3.js + @solana/spl-token to compute
 * the canonical ATA. Loaded lazily (via dynamic import) so test code that
 * injects a stub resolver doesn't pay the cost.
 */
function buildProductionResolver(
  usdcMint: string,
): (walletPubkey: string) => Promise<string> {
  return async (walletPubkey: string): Promise<string> => {
    const [{ PublicKey }, { getAssociatedTokenAddressSync }] = await Promise.all(
      [import("@solana/web3.js"), import("@solana/spl-token")],
    );
    const owner = new PublicKey(walletPubkey);
    const mint = new PublicKey(usdcMint);
    return getAssociatedTokenAddressSync(mint, owner).toBase58();
  };
}
