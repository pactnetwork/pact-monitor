// @pact-network/wrap — agent balance & allowance check.
//
// Before forwarding a wrapped fetch, wrap optionally verifies that the
// agent's USDC ATA holds enough balance AND has delegated at least
// `requiredLamports` to Pact's settlement authority. This prevents wrap
// from charging premiums it can't actually settle on-chain.
//
// The default impl reads the SPL-Token account via Solana RPC over plain
// `fetch` — no Solana SDK dependency in the hot path. Consumers wanting
// `@solana/kit` integration can implement `BalanceCheck` themselves and
// inject it.

export type BalanceCheckRejectionReason =
  | "insufficient_balance"
  | "insufficient_allowance"
  | "no_ata";

export type BalanceCheckResult =
  | { eligible: true; ataBalance: bigint; allowance: bigint }
  | {
      eligible: false;
      reason: BalanceCheckRejectionReason;
      ataBalance?: bigint;
      allowance?: bigint;
    };

export interface BalanceCheck {
  check(walletPubkey: string, requiredLamports: bigint): Promise<BalanceCheckResult>;
}

// ---------------------------------------------------------------------------
// Default impl: read agent USDC ATA via Solana JSON-RPC.
// ---------------------------------------------------------------------------

export interface DefaultBalanceCheckOptions {
  /** Solana JSON-RPC endpoint URL, e.g. "https://api.mainnet-beta.solana.com". */
  rpcUrl: string;
  /**
   * Function that derives the agent's USDC ATA pubkey for a given wallet.
   * Wrap doesn't bake in mint or program assumptions; the consumer wires
   * this up so the same wrap instance can serve mainnet/devnet/USDC/USDT.
   */
  resolveAta: (walletPubkey: string) => string | Promise<string>;
  /** TTL for the in-memory result cache, in milliseconds. Default 30_000. */
  cacheTtlMs?: number;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override clock (tests). */
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  ataBalance: bigint;
  allowance: bigint;
  /** True if the ATA does not exist (we cache the negative result too). */
  noAta: boolean;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * Default `BalanceCheck` implementation. 30s in-memory LRU-ish cache (it's
 * actually a TTL Map; under the volume one wrap instance handles in 30s a
 * Map is fine and simpler than a real LRU).
 */
export function createDefaultBalanceCheck(
  opts: DefaultBalanceCheckOptions,
): BalanceCheck {
  const cache = new Map<string, CacheEntry>();
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  async function load(walletPubkey: string): Promise<CacheEntry> {
    const ata = await opts.resolveAta(walletPubkey);

    // 1) getTokenAccountBalance — confirms ATA exists and gives raw amount.
    const balanceResp = await rpc(fetchImpl, opts.rpcUrl, "getTokenAccountBalance", [
      ata,
      { commitment: "confirmed" },
    ]);
    if (balanceResp.error) {
      // -32602 with "could not find account" = ATA doesn't exist.
      const msg = (balanceResp.error.message ?? "").toLowerCase();
      if (
        balanceResp.error.code === -32602 ||
        msg.includes("could not find") ||
        msg.includes("not found") ||
        msg.includes("invalid")
      ) {
        const entry: CacheEntry = {
          expiresAt: now() + ttl,
          ataBalance: 0n,
          allowance: 0n,
          noAta: true,
        };
        return entry;
      }
      throw new Error(
        `wrap.balanceCheck: getTokenAccountBalance failed: ${balanceResp.error.message}`,
      );
    }

    const ataBalance = BigInt(balanceResp.result?.value?.amount ?? "0");

    // 2) getAccountInfo (jsonParsed) — extract delegated_amount.
    const accountResp = await rpc(fetchImpl, opts.rpcUrl, "getAccountInfo", [
      ata,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    if (accountResp.error) {
      throw new Error(
        `wrap.balanceCheck: getAccountInfo failed: ${accountResp.error.message}`,
      );
    }
    const value = accountResp.result?.value;
    if (!value) {
      // ATA not found via getAccountInfo (race after balance call).
      return {
        expiresAt: now() + ttl,
        ataBalance: 0n,
        allowance: 0n,
        noAta: true,
      };
    }

    const delegatedAmountStr =
      value?.data?.parsed?.info?.delegatedAmount?.amount ?? "0";
    const allowance = BigInt(delegatedAmountStr);

    return {
      expiresAt: now() + ttl,
      ataBalance,
      allowance,
      noAta: false,
    };
  }

  return {
    async check(walletPubkey: string, requiredLamports: bigint): Promise<BalanceCheckResult> {
      const cached = cache.get(walletPubkey);
      let entry: CacheEntry;
      if (cached && cached.expiresAt > now()) {
        entry = cached;
      } else {
        entry = await load(walletPubkey);
        cache.set(walletPubkey, entry);
      }

      if (entry.noAta) {
        return { eligible: false, reason: "no_ata" };
      }
      if (entry.ataBalance < requiredLamports) {
        return {
          eligible: false,
          reason: "insufficient_balance",
          ataBalance: entry.ataBalance,
          allowance: entry.allowance,
        };
      }
      if (entry.allowance < requiredLamports) {
        return {
          eligible: false,
          reason: "insufficient_allowance",
          ataBalance: entry.ataBalance,
          allowance: entry.allowance,
        };
      }
      return {
        eligible: true,
        ataBalance: entry.ataBalance,
        allowance: entry.allowance,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client (no @solana/kit dependency).
// ---------------------------------------------------------------------------

interface RpcResponse {
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  params: unknown[],
): Promise<RpcResponse> {
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!resp.ok) {
    throw new Error(`wrap.balanceCheck: RPC ${method} returned ${resp.status}`);
  }
  return (await resp.json()) as RpcResponse;
}
