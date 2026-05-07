import { Connection, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_MAINNET,
} from "@pact-network/protocol-v1-client";

// v0.1.0 is mainnet-only — the SDK is the single source of truth for the
// program ID (baked to 5bCJcdWdK… by develop's PR #71) and the USDC mint.
// Local devnet testing requires sed-replacing constants.rs and rebuilding the
// program per Rick's runbook; the binary does not support it.
export const USDC_MAINNET_MINT = USDC_MINT_MAINNET;
export const PACT_NETWORK_V1_PROGRAM_ID = PROGRAM_ID;

export type ClusterConfig = { programId: PublicKey; mint: PublicKey };
export type ClusterConfigResult = ClusterConfig | { error: string };

// Enforce the PACT_MAINNET_ENABLED speed-bump at point-of-use. Commander's
// `--cluster` validator only fires when the user passes the option explicitly;
// the default value bypasses validation, so the gate is re-checked here so a
// bare `pact balance` / `pact run` cannot silently route to mainnet.
export function resolveClusterConfig(): ClusterConfigResult {
  if (process.env.PACT_MAINNET_ENABLED !== "1") {
    return {
      error:
        "v0.1.0 is mainnet-only and requires PACT_MAINNET_ENABLED=1 (closed beta gate)",
    };
  }
  return { programId: PROGRAM_ID, mint: USDC_MINT_MAINNET };
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
