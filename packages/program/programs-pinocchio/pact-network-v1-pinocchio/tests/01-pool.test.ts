import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PROGRAM_ID,
  loadProgram,
  generateKeypair,
  airdrop,
  setupUsdcMint,
  deriveCoveragePool,
  deriveSettlementAuthority,
  buildInitializeCoveragePool,
  buildInitializeSettlementAuthority,
  buildDepositUsdc,
  deriveAgentWallet,
  slugBytes,
  getAccountData,
  readU64,
  readI64,
  sendTx,
} from "./helpers";

function setup() {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuthority = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuthority);
  const [poolPda] = deriveCoveragePool();
  const vaultKp = Keypair.generate();
  return { svm, authority, mint, poolPda, vaultKp, mintAuthority };
}

test("initialize_coverage_pool creates singleton with correct state", () => {
  const { svm, authority, mint, poolPda, vaultKp } = setup();

  const tx = buildInitializeCoveragePool(authority.publicKey, poolPda, vaultKp.publicKey, mint, svm);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);
  if ("err" in result) console.log("INIT ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, poolPda);
  expect(data).not.toBeNull();
  expect(data!.length).toBeGreaterThanOrEqual(144);

  // bump at byte 0 — nonzero
  expect(data![0]).toBeGreaterThan(0);
  // authority at bytes 8-39
  expect(Buffer.from(data!.slice(8, 40)).toString("hex")).toBe(
    authority.publicKey.toBuffer().toString("hex")
  );
  // total_deposits, total_premiums, total_refunds, current_balance all zero
  expect(readU64(data!, 104)).toBe(0n); // total_deposits
  expect(readU64(data!, 112)).toBe(0n); // total_premiums
  expect(readU64(data!, 120)).toBe(0n); // total_refunds
  expect(readU64(data!, 128)).toBe(0n); // current_balance
  // created_at nonzero
  expect(readI64(data!, 136)).toBeGreaterThan(0n);
});

test("initialize_coverage_pool fails on duplicate", () => {
  const { svm, authority, mint, poolPda, vaultKp } = setup();

  const tx1 = buildInitializeCoveragePool(authority.publicKey, poolPda, vaultKp.publicKey, mint, svm);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = authority.publicKey;
  tx1.sign(authority);
  svm.sendTransaction(tx1);

  // Second attempt with new vault
  const vaultKp2 = Keypair.generate();
  svm.setAccount(vaultKp2.publicKey, {
    lamports: 2_000_000n,
    data: new Uint8Array(165),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
  const tx2 = buildInitializeCoveragePool(authority.publicKey, poolPda, vaultKp2.publicKey, mint, svm);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = authority.publicKey;
  tx2.sign(authority);
  const result = svm.sendTransaction(tx2);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("initialize_settlement_authority creates PDA with correct signer", () => {
  const { svm, authority, mint, poolPda, vaultKp } = setup();

  // First init pool
  const tx1 = buildInitializeCoveragePool(authority.publicKey, poolPda, vaultKp.publicKey, mint, svm);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = authority.publicKey;
  tx1.sign(authority);
  svm.sendTransaction(tx1);

  const settler = Keypair.generate();
  const [saPda] = deriveSettlementAuthority();

  const ix = buildInitializeSettlementAuthority(
    authority.publicKey,
    poolPda,
    saPda,
    settler.publicKey
  );
  const tx2 = new Transaction();
  tx2.add(ix);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = authority.publicKey;
  tx2.sign(authority);
  const result = svm.sendTransaction(tx2);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, saPda);
  expect(data).not.toBeNull();
  // signer at bytes 8-39
  expect(Buffer.from(data!.slice(8, 40)).toString("hex")).toBe(
    settler.publicKey.toBuffer().toString("hex")
  );
});

test("initialize_settlement_authority rejected for non-authority", () => {
  const { svm, authority, mint, poolPda, vaultKp } = setup();

  const tx1 = buildInitializeCoveragePool(authority.publicKey, poolPda, vaultKp.publicKey, mint, svm);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = authority.publicKey;
  tx1.sign(authority);
  svm.sendTransaction(tx1);

  const attacker = generateKeypair(svm);
  const settler = Keypair.generate();
  const [saPda] = deriveSettlementAuthority();

  const ix = buildInitializeSettlementAuthority(
    attacker.publicKey, // wrong signer
    poolPda,
    saPda,
    settler.publicKey
  );
  const tx2 = new Transaction();
  tx2.add(ix);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = attacker.publicKey;
  tx2.sign(attacker);
  const result = svm.sendTransaction(tx2);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});
