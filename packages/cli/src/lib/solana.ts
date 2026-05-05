import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { PactInsurance } from "@q3labs/pact-insurance";

export const USDC_DEVNET_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const USDC_MAINNET_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const PACT_INSURANCE_PROGRAM_ID_DEVNET = new PublicKey(
  "7i9zJtfXk4QZjHTdY3xyfJsa92QzM4ymCCDYZb6sDqv6",
);

export function agentWalletPda(agentPubkey: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_wallet"), agentPubkey.toBuffer()],
    programId,
  );
  return pda;
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

export async function depositUsdc(opts: {
  connection: Connection;
  keypair: Keypair;
  programId: PublicKey;
  providerHostname: string;
  amountUsdc: number;
  rpcUrl: string;
}): Promise<{ tx_signature: string; confirmation_pending: boolean }> {
  const insurance = new PactInsurance(
    {
      rpcUrl: opts.rpcUrl,
      programId: opts.programId.toBase58(),
    },
    opts.keypair,
  );
  const sig = await insurance.topUpDelegation({
    providerHostname: opts.providerHostname,
    newTotalAllowanceUsdc: BigInt(Math.floor(opts.amountUsdc * 1_000_000)),
  });
  return { tx_signature: sig, confirmation_pending: false };
}
