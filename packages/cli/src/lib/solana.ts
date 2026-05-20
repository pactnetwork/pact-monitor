import { Connection, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  PROGRAM_ID_DEVNET,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "@q3labs/pact-protocol-v1-client";

// Mainnet identifiers — kept for backward compat with existing call sites
// (balance.ts, approve.ts, run.ts, pay.ts, pause.ts).
export const USDC_MAINNET_MINT = USDC_MINT_MAINNET;
export const PACT_NETWORK_V1_PROGRAM_ID = PROGRAM_ID;

export type Cluster = "mainnet" | "devnet";

export type ClusterConfig = { programId: PublicKey; mint: PublicKey };
export type ClusterConfigResult = ClusterConfig | { error: string };

/**
 * Resolve program id + USDC mint for the given cluster.
 *
 * - `mainnet` (default for backward compat): requires PACT_MAINNET_ENABLED=1.
 *   Returns canonical mainnet `PROGRAM_ID` + `USDC_MINT_MAINNET`. The env gate
 *   is a defensive speed-bump so a bare invocation can't silently route real
 *   USDC.
 * - `devnet`: returns `PROGRAM_ID_DEVNET` (`5jBQb7fL…`) + `USDC_MINT_DEVNET`
 *   (`4zMMC9…`). NO env gate — devnet is a developer playground. Note: the
 *   devnet binary's `declare_id!` is the mainnet id, so `settle_batch` reverts
 *   InvalidSeeds on devnet — operator ops (register/pause/update/topup)
 *   work fine; settlement-dependent flows do not.
 */
export function resolveClusterConfig(
  cluster: Cluster = "mainnet",
): ClusterConfigResult {
  if (cluster === "mainnet") {
    if (process.env.PACT_MAINNET_ENABLED !== "1") {
      return {
        error:
          "v0.1.0 mainnet is gated — set PACT_MAINNET_ENABLED=1 (closed beta) or pass --cluster devnet",
      };
    }
    return { programId: PROGRAM_ID, mint: USDC_MINT_MAINNET };
  }
  if (cluster === "devnet") {
    return { programId: PROGRAM_ID_DEVNET, mint: USDC_MINT_DEVNET };
  }
  return { error: `unknown cluster: ${cluster}` };
}

export async function getUsdcAtaBalanceLamports(opts: {
  connection: Connection;
  agentPubkey: PublicKey;
  mint: PublicKey;
}): Promise<bigint> {
  const ata = getAssociatedTokenAddress(opts.mint, opts.agentPubkey);
  const info = await opts.connection.getTokenAccountBalance(ata).catch(() => null);
  if (!info?.value) return 0n;
  return BigInt(info.value.amount);
}

function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}
