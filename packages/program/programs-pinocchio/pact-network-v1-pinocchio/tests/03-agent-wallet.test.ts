import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  loadProgram, generateKeypair, setupUsdcMint,
  deriveCoveragePool, deriveAgentWallet,
  buildInitializeCoveragePool, buildInitializeAgentWallet,
  getAccountData, readU64,
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

  return { svm, authority, mint, poolPda };
}

test("initialize_agent_wallet creates wallet with correct state", () => {
  const { svm, mint } = setup();
  const agent = generateKeypair(svm);
  const [walletPda] = deriveAgentWallet(agent.publicKey);
  const walletVaultKp = Keypair.generate();

  const ix = buildInitializeAgentWallet(agent.publicKey, walletPda, walletVaultKp.publicKey, mint, svm);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, walletPda);
  expect(data).not.toBeNull();
  // owner at bytes 8-39
  expect(Buffer.from(data!.slice(8, 40)).toString("hex")).toBe(
    agent.publicKey.toBuffer().toString("hex")
  );
  // balance = 0 at offset 72
  expect(readU64(data!, 72)).toBe(0n);
});

test("initialize_agent_wallet idempotent fails on reinit", () => {
  const { svm, mint } = setup();
  const agent = generateKeypair(svm);
  const [walletPda] = deriveAgentWallet(agent.publicKey);
  const walletVaultKp = Keypair.generate();

  const ix = () => buildInitializeAgentWallet(agent.publicKey, walletPda, walletVaultKp.publicKey, mint, svm);

  for (let i = 0; i < 2; i++) {
    const tx = new Transaction();
    tx.add(ix());
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = agent.publicKey;
    tx.sign(agent);
    const result = svm.sendTransaction(tx);
    if (i === 0) expect(result instanceof FailedTransactionMetadata).toBe(false);
    else expect(result instanceof FailedTransactionMetadata).toBe(true);
  }
});
