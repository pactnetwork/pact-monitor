import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  loadProgram, generateKeypair, setupUsdcMint,
  deriveCoveragePool, deriveEndpointConfig, slugBytes,
  buildInitializeCoveragePool, buildRegisterEndpoint,
  getAccountData, readU64, readI64, sendTx,
  PROGRAM_ID,
} from "./helpers";

function setupWithPool() {
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

  return { svm, authority, mint, poolPda };
}

test("register_endpoint creates endpoint with correct state", () => {
  const { svm, authority, poolPda } = setupWithPool();
  const slug = slugBytes("helius");
  const [epPda] = deriveEndpointConfig(slug);

  const ix = buildRegisterEndpoint(
    authority.publicKey, poolPda, epPda, slug,
    500n, 0, 5000, 1000n, 1_000_000n
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, epPda);
  expect(data).not.toBeNull();
  // paused at byte 1 = 0
  expect(data![1]).toBe(0);
  // slug at bytes 8-23
  expect(Buffer.from(data!.slice(8, 24))).toEqual(Buffer.from(slug));
  // flat_premium_lamports at bytes 24-31 = 500
  expect(readU64(data!, 24)).toBe(500n);
});

test("register_endpoint rejected for non-authority", () => {
  const { svm, poolPda } = setupWithPool();
  const attacker = generateKeypair(svm);
  const slug = slugBytes("helius");
  const [epPda] = deriveEndpointConfig(slug);

  const ix = buildRegisterEndpoint(
    attacker.publicKey, poolPda, epPda, slug,
    500n, 0, 5000, 1000n, 1_000_000n
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejected for invalid slug (non-ASCII)", () => {
  const { svm, authority, poolPda } = setupWithPool();
  const badSlug = new Uint8Array(16);
  badSlug[0] = 0x80; // non-ASCII
  const [epPda] = deriveEndpointConfig(badSlug);

  const ix = buildRegisterEndpoint(
    authority.publicKey, poolPda, epPda, badSlug,
    500n, 0, 5000, 1000n, 1_000_000n
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejected for duplicate slug", () => {
  const { svm, authority, poolPda } = setupWithPool();
  const slug = slugBytes("helius");
  const [epPda] = deriveEndpointConfig(slug);

  const buildIx = () => buildRegisterEndpoint(
    authority.publicKey, poolPda, epPda, slug,
    500n, 0, 5000, 1000n, 1_000_000n
  );

  for (let i = 0; i < 2; i++) {
    const tx = new Transaction();
    tx.add(buildIx());
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = authority.publicKey;
    tx.sign(authority);
    const result = svm.sendTransaction(tx);
    if (i === 0) expect(result instanceof FailedTransactionMetadata).toBe(false);
    else expect(result instanceof FailedTransactionMetadata).toBe(true);
  }
});

test("update_endpoint_config updates flat_premium only", () => {
  const { svm, authority, poolPda } = setupWithPool();
  const slug = slugBytes("helius");
  const [epPda] = deriveEndpointConfig(slug);

  // Register first
  const regIx = buildRegisterEndpoint(authority.publicKey, poolPda, epPda, slug, 500n, 0, 5000, 1000n, 1_000_000n);
  const regTx = new Transaction();
  regTx.add(regIx);
  regTx.recentBlockhash = svm.latestBlockhash();
  regTx.feePayer = authority.publicKey;
  regTx.sign(authority);
  svm.sendTransaction(regTx);

  // Update flat_premium to 999
  const updateData = Buffer.alloc(36);
  updateData[0] = 3; // discriminator update_endpoint_config
  // flat_premium present=1, value=999
  updateData[1] = 1;
  new DataView(updateData.buffer).setBigUint64(2, 999n, true);
  // rest = 0 (not present)

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: epPda, isSigner: false, isWritable: true },
    ],
    data: updateData,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);
  const data = getAccountData(svm, epPda);
  expect(readU64(data!, 24)).toBe(999n); // flat_premium updated
});
