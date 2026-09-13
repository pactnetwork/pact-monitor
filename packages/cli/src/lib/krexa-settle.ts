// Krexa Compute Gateway settlement: build a USDC SPL Token transfer from the
// agent's ATA to the gateway's payTo ATA, sign with the project wallet, submit
// to mainnet, return the tx signature. The signature becomes the proof carried
// in the `PAYMENT-SIGNATURE` retry header.
//
// We hand-craft the SPL TransferChecked instruction so this POC does not pull
// `@solana/spl-token` into the CLI for one instruction. USDC mainnet has 6
// decimals; the challenge always carries amounts in base units, so the value
// shipped on the wire is identical to what the instruction expects.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const USDC_MAINNET_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
export const USDC_DECIMALS = 6;

function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

function buildTransferCheckedIx(args: {
  source: PublicKey;
  mint: PublicKey;
  dest: PublicKey;
  owner: PublicKey;
  amountBaseUnits: bigint;
  decimals: number;
}): TransactionInstruction {
  // SPL Token TransferChecked layout: [u8 discriminator=12, u64 LE amount, u8 decimals].
  const data = Buffer.alloc(1 + 8 + 1);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(args.amountBaseUnits, 1);
  data.writeUInt8(args.decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.dest, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface SettleInput {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  recipient: PublicKey;
  amountBaseUnits: bigint;
  decimals?: number;
}

export interface SettleResult {
  signature: string;
  source: string;
  destination: string;
}

export async function settleKrexaPayment(
  input: SettleInput,
): Promise<SettleResult> {
  const decimals = input.decimals ?? USDC_DECIMALS;
  const source = getAssociatedTokenAddress(input.mint, input.payer.publicKey);
  const dest = getAssociatedTokenAddress(input.mint, input.recipient);

  const ix = buildTransferCheckedIx({
    source,
    mint: input.mint,
    dest,
    owner: input.payer.publicKey,
    amountBaseUnits: input.amountBaseUnits,
    decimals,
  });

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(
    input.connection,
    tx,
    [input.payer],
    { commitment: "confirmed" },
  );

  return {
    signature,
    source: source.toBase58(),
    destination: dest.toBase58(),
  };
}

export function defaultMainnetRpcUrl(): string {
  return process.env.KREXA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
}
