import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  PROGRAM_ID,
  loadProgram, generateKeypair, setupUsdcMint,
  deriveCoveragePool, deriveEndpointConfig, slugBytes,
  buildInitializeCoveragePool, buildRegisterEndpoint,
  getAccountData,
} from "./helpers";

function setup() {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);
  const [poolPda] = deriveCoveragePool();
  const vaultKp = Keypair.generate();

  const tx = buildInitializeCoveragePool(authority.publicKey, poolPda, vaultKp.publicKey, mint, svm);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  svm.sendTransaction(tx);

  const slug = slugBytes("birdeye");
  const [epPda] = deriveEndpointConfig(slug);
  const regIx = buildRegisterEndpoint(authority.publicKey, poolPda, epPda, slug, 500n, 0, 5000, 1000n, 1_000_000n);
  const regTx = new Transaction();
  regTx.add(regIx);
  regTx.recentBlockhash = svm.latestBlockhash();
  regTx.feePayer = authority.publicKey;
  regTx.sign(authority);
  svm.sendTransaction(regTx);

  return { svm, authority, poolPda, epPda };
}

function buildPauseIx(authority: PublicKey, poolPda: PublicKey, epPda: PublicKey, paused: boolean): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: epPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([4, paused ? 1 : 0]),
  });
}

test("pause_endpoint sets paused flag", () => {
  const { svm, authority, poolPda, epPda } = setup();

  const ix = buildPauseIx(authority.publicKey, poolPda, epPda, true);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);
  const data = getAccountData(svm, epPda)!;
  expect(data[1]).toBe(1); // paused flag
});

test("pause_endpoint can unpause", () => {
  const { svm, authority, poolPda, epPda } = setup();

  // Pause
  const ix1 = buildPauseIx(authority.publicKey, poolPda, epPda, true);
  const tx1 = new Transaction();
  tx1.add(ix1);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = authority.publicKey;
  tx1.sign(authority);
  svm.sendTransaction(tx1);

  // Unpause
  const ix2 = buildPauseIx(authority.publicKey, poolPda, epPda, false);
  const tx2 = new Transaction();
  tx2.add(ix2);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = authority.publicKey;
  tx2.sign(authority);
  svm.sendTransaction(tx2);

  const data = getAccountData(svm, epPda)!;
  expect(data[1]).toBe(0);
});

test("pause_endpoint rejected for non-authority", () => {
  const { svm, poolPda, epPda } = setup();
  const attacker = generateKeypair(svm);

  const ix = buildPauseIx(attacker.publicKey, poolPda, epPda, true);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});
