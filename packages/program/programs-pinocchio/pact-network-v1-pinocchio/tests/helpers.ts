import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { LiteSVM, Account, ComputeBudget, Clock } from "litesvm";
import { TOKEN_PROGRAM_ID, createInitializeAccount2Instruction, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as path from "path";
import { fileURLToPath } from "url";

export const PROGRAM_ID = new PublicKey("DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc");

// Devnet USDC mint
export const USDC_MINT_PUBKEY = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const SO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../target/deploy/pact_network_v1.so"
);

export function loadProgram(svm: LiteSVM, programId: PublicKey = PROGRAM_ID): void {
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  svm.setClock(new Clock(0n, nowSecs, 0n, 1n, nowSecs));
  const budget = new ComputeBudget();
  budget.computeUnitLimit = 1_400_000n;
  svm.withComputeBudget(budget);
  svm.addProgramFromFile(programId, SO_PATH);
}

export function airdrop(svm: LiteSVM, pubkey: PublicKey, lamports: bigint = 10_000_000_000n): void {
  svm.setAccount(pubkey, {
    lamports,
    data: new Uint8Array(0),
    owner: SystemProgram.programId,
    executable: false,
  });
}

export function generateKeypair(svm: LiteSVM): Keypair {
  const kp = Keypair.generate();
  airdrop(svm, kp.publicKey);
  return kp;
}

// PDA derivation
export function deriveCoveragePool(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("coverage_pool")], PROGRAM_ID);
}

export function deriveSettlementAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("settlement_authority")], PROGRAM_ID);
}

export function deriveEndpointConfig(slug: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("endpoint"), slug], PROGRAM_ID);
}

export function deriveAgentWallet(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("agent_wallet"), owner.toBuffer()], PROGRAM_ID);
}

export function deriveCallRecord(callId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("call"), callId], PROGRAM_ID);
}

export function slugBytes(slug: string): Uint8Array {
  const buf = new Uint8Array(16);
  const encoded = new TextEncoder().encode(slug.slice(0, 16));
  buf.set(encoded);
  return buf;
}

// Mint a test USDC-like token — always uses the devnet USDC address so the program's mint check passes
export function setupUsdcMint(svm: LiteSVM, mintAuthority: Keypair): PublicKey {
  const mintData = new Uint8Array(82);
  const view = new DataView(mintData.buffer);
  view.setUint32(0, 1, true); // COption::Some
  mintData.set(mintAuthority.publicKey.toBytes(), 4);
  mintData[44] = 6;  // decimals
  mintData[45] = 1;  // is_initialized

  svm.setAccount(USDC_MINT_PUBKEY, {
    lamports: 1_000_000_000n,
    data: mintData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  return USDC_MINT_PUBKEY;
}

export function createTokenAccount(
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey
): PublicKey {
  const tokenAcctKp = Keypair.generate();
  const tokenData = new Uint8Array(165);
  // mint (0-31)
  tokenData.set(mint.toBytes(), 0);
  // owner (32-63)
  tokenData.set(owner.toBytes(), 32);
  // amount (64-71) = 0
  // delegate option = none (72-75 = 0)
  // state (108) = 1 (initialized)
  tokenData[108] = 1;
  // is_native option none (109-120 = 0)
  // delegated_amount (121-128) = 0
  // close_authority none (129-164 = 0)

  svm.setAccount(tokenAcctKp.publicKey, {
    lamports: 2_039_280n,
    data: tokenData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  return tokenAcctKp.publicKey;
}

export function mintTokensToAccount(svm: LiteSVM, tokenAccount: PublicKey, amount: bigint): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error("token account not found");
  const data = new Uint8Array(acct.data);
  const view = new DataView(data.buffer);
  const current = view.getBigUint64(64, true);
  view.setBigUint64(64, current + amount, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

export function getTokenBalance(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) return 0n;
  return new DataView(acct.data.buffer).getBigUint64(64, true);
}

export function getAccountData(svm: LiteSVM, pubkey: PublicKey): Uint8Array | null {
  const acct = svm.getAccount(pubkey);
  return acct ? new Uint8Array(acct.data) : null;
}

// Read u64 LE from offset in account data
export function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer).getBigUint64(offset, true);
}

export function readI64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer).getBigInt64(offset, true);
}

// Instruction builders
export function buildInitializeCoveragePool(
  authority: PublicKey,
  poolPda: PublicKey,
  vault: PublicKey,
  mint: PublicKey,
  svm: LiteSVM
): Transaction {
  // Pre-allocate vault as token account (165 bytes, owner=TOKEN_PROGRAM_ID)
  svm.setAccount(vault, {
    lamports: 2_039_280n,
    data: new Uint8Array(165),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0]), // discriminator 0
  });

  const tx = new Transaction();
  tx.add(ix);
  return tx;
}

export function buildInitializeSettlementAuthority(
  authority: PublicKey,
  poolPda: PublicKey,
  settlementAuthPda: PublicKey,
  settlerSigner: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(33);
  data[0] = 1; // discriminator
  settlerSigner.toBuffer().copy(data, 1);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: settlementAuthPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildRegisterEndpoint(
  authority: PublicKey,
  poolPda: PublicKey,
  endpointPda: PublicKey,
  slug: Uint8Array,
  flatPremium: bigint,
  percentBps: number,
  slaMs: number,
  imputedCost: bigint,
  exposureCap: bigint
): TransactionInstruction {
  const data = Buffer.alloc(47);
  data[0] = 2; // discriminator
  data.set(slug, 1);
  new DataView(data.buffer).setBigUint64(17, flatPremium, true);
  new DataView(data.buffer).setUint16(25, percentBps, true);
  new DataView(data.buffer).setUint32(27, slaMs, true);
  new DataView(data.buffer).setBigUint64(31, imputedCost, true);
  new DataView(data.buffer).setBigUint64(39, exposureCap, true);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: endpointPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeAgentWallet(
  owner: PublicKey,
  walletPda: PublicKey,
  vaultPubkey: PublicKey,
  mint: PublicKey,
  svm: LiteSVM
): TransactionInstruction {
  // Pre-allocate vault token account
  svm.setAccount(vaultPubkey, {
    lamports: 2_039_280n,
    data: new Uint8Array(165),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([5]), // discriminator
  });
}

export function buildDepositUsdc(
  owner: PublicKey,
  walletPda: PublicKey,
  ownerAta: PublicKey,
  walletVault: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 6;
  new DataView(data.buffer).setBigUint64(1, amount, true);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: walletVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function sendTx(
  svm: LiteSVM,
  instructions: TransactionInstruction[],
  signers: Keypair[]
): { err: any } {
  const tx = new Transaction();
  tx.add(...instructions);
  const result = svm.sendTransaction(tx);
  if ("err" in result) return { err: result.err };
  return { err: null };
}

export { TOKEN_PROGRAM_ID, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair, PublicKey, Transaction, TransactionInstruction };
