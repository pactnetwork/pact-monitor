import { Connection, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "@pact-network/protocol-v1-client";

// Re-export under names the CLI has historically used. The new SDK is the
// single source of truth for both the program ID and the USDC mints; the
// CLI never carries its own copy.
export const USDC_DEVNET_MINT = USDC_MINT_DEVNET;
export const USDC_MAINNET_MINT = USDC_MINT_MAINNET;
export const PACT_NETWORK_V1_PROGRAM_ID = PROGRAM_ID;

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
