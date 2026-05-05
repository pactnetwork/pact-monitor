import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PROGRAM_ID,
  loadProgram, generateKeypair, setupUsdcMint,
  deriveCoveragePool, deriveAgentWallet,
  buildInitializeCoveragePool, buildInitializeAgentWallet, buildDepositUsdc,
  createTokenAccount, mintTokensToAccount, getTokenBalance,
  getAccountData, readU64, readI64,
} from "./helpers";

function fullSetup() {
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

  const agent = generateKeypair(svm);
  const [walletPda] = deriveAgentWallet(agent.publicKey);
  const walletVaultKp = Keypair.generate();
  const ix = buildInitializeAgentWallet(agent.publicKey, walletPda, walletVaultKp.publicKey, mint, svm);
  const tx2 = new Transaction();
  tx2.add(ix);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = agent.publicKey;
  tx2.sign(agent);
  svm.sendTransaction(tx2);

  // Create and fund agent ATA
  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, 10_000_000n); // 10 USDC

  return { svm, authority, mint, poolPda, agent, walletPda, walletVault: walletVaultKp.publicKey, agentAta };
}

test("deposit_usdc increases balance and total_deposits", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();

  const ix = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVault, 5_000_000n);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, walletPda);
  expect(readU64(data!, 72)).toBe(5_000_000n); // balance
  expect(readU64(data!, 80)).toBe(5_000_000n); // total_deposits

  // Vault should have received tokens
  expect(getTokenBalance(svm, walletVault)).toBe(5_000_000n);
});

test("deposit_usdc rejected when exceeds MAX_DEPOSIT_LAMPORTS (25 USDC)", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();
  mintTokensToAccount(svm, agentAta, 100_000_000n); // extra funds

  const ix = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVault, 26_000_000n);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("request_withdrawal sets pending state", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();

  // Deposit first
  const depIx = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVault, 5_000_000n);
  const depTx = new Transaction();
  depTx.add(depIx);
  depTx.recentBlockhash = svm.latestBlockhash();
  depTx.feePayer = agent.publicKey;
  depTx.sign(agent);
  svm.sendTransaction(depTx);

  // Request withdrawal of 2 USDC
  const reqData = Buffer.alloc(9);
  reqData[0] = 7; // discriminator
  new DataView(reqData.buffer).setBigUint64(1, 2_000_000n, true);
  const reqIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: agent.publicKey, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
    ],
    data: reqData,
  });
  const reqTx = new Transaction();
  reqTx.add(reqIx);
  reqTx.recentBlockhash = svm.latestBlockhash();
  reqTx.feePayer = agent.publicKey;
  reqTx.sign(agent);
  const result = svm.sendTransaction(reqTx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, walletPda);
  // pending_withdrawal at offset 112 (1+7+32+32+8+8+8+8+8+8 = 120 - 8)
  // AgentWallet layout: bump(1)+pad(7)+owner(32)+vault(32)+balance(8)+total_deposits(8)+total_premiums(8)+total_refunds_received(8)+total_refunds_claimed(8)+call_count(8)+pending_withdrawal(8)+withdrawal_unlock_at(8)+created_at(8)
  // offset of pending_withdrawal = 1+7+32+32+8+8+8+8+8+8 = 120
  expect(readU64(data!, 120)).toBe(2_000_000n);
  // withdrawal_unlock_at > now
  expect(readI64(data!, 128)).toBeGreaterThan(0n);
});

test("request_withdrawal rejected if amount exceeds balance", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();

  // No deposit — balance is 0
  const reqData = Buffer.alloc(9);
  reqData[0] = 7;
  new DataView(reqData.buffer).setBigUint64(1, 1_000_000n, true);
  const reqIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: agent.publicKey, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
    ],
    data: reqData,
  });
  const tx = new Transaction();
  tx.add(reqIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});
