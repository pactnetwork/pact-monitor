import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PROGRAM_ID,
  loadProgram, generateKeypair, setupUsdcMint,
  deriveCoveragePool, deriveSettlementAuthority, deriveEndpointConfig,
  deriveAgentWallet, deriveCallRecord, slugBytes,
  buildInitializeCoveragePool, buildInitializeSettlementAuthority,
  buildRegisterEndpoint, buildInitializeAgentWallet, buildDepositUsdc,
  createTokenAccount, mintTokensToAccount, getTokenBalance,
  getAccountData, readU64,
} from "./helpers";

function buildSettleBatchIx(
  settler: PublicKey,
  settlementAuthPda: PublicKey,
  poolPda: PublicKey,
  poolVault: PublicKey,
  events: Array<{
    callId: Uint8Array;
    agentOwner: PublicKey;
    agentVault: PublicKey;
    endpointPda: PublicKey;
    slug: Uint8Array;
    premium: bigint;
    refund: bigint;
    latencyMs: number;
    breach: boolean;
    timestamp: number;
  }>,
  callRecordPdas: PublicKey[],
  agentWalletPdas: PublicKey[]
): TransactionInstruction {
  const BYTES_PER_EVENT = 100;
  const data = Buffer.alloc(2 + events.length * BYTES_PER_EVENT);
  new DataView(data.buffer).setUint16(0, events.length, true);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const off = 2 + i * BYTES_PER_EVENT;
    data.set(e.callId, off);
    data.set(e.agentOwner.toBuffer(), off + 16);
    data.set(e.slug, off + 48);
    new DataView(data.buffer).setBigUint64(off + 64, e.premium, true);
    new DataView(data.buffer).setBigUint64(off + 72, e.refund, true);
    new DataView(data.buffer).setUint32(off + 80, e.latencyMs, true);
    data[off + 84] = e.breach ? 1 : 0;
    new DataView(data.buffer).setBigInt64(off + 92, BigInt(e.timestamp), true);
  }

  const fullData = Buffer.alloc(1 + data.length);
  fullData[0] = 10; // discriminator settle_batch
  data.copy(fullData, 1);

  const keys = [
    { pubkey: settler, isSigner: true, isWritable: true },
    { pubkey: settlementAuthPda, isSigner: false, isWritable: false },
    { pubkey: poolPda, isSigner: false, isWritable: true },
    { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PublicKey.default, isSigner: false, isWritable: false },
  ];

  for (let i = 0; i < events.length; i++) {
    keys.push({ pubkey: callRecordPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: agentWalletPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].agentVault, isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].endpointPda, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: fullData });
}

function buildClaimRefundIx(
  owner: PublicKey,
  walletPda: PublicKey,
  walletVault: PublicKey,
  ownerAta: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 11; // discriminator claim_refund
  new DataView(data.buffer).setBigUint64(1, amount, true);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: walletVault, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function fullSetup() {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);
  const [poolPda] = deriveCoveragePool();
  const poolVaultKp = Keypair.generate();

  const initTx = buildInitializeCoveragePool(authority.publicKey, poolPda, poolVaultKp.publicKey, mint, svm);
  initTx.recentBlockhash = svm.latestBlockhash();
  initTx.feePayer = authority.publicKey;
  initTx.sign(authority);
  svm.sendTransaction(initTx);

  const settler = generateKeypair(svm);
  const [saPda] = deriveSettlementAuthority();
  const saIx = buildInitializeSettlementAuthority(authority.publicKey, poolPda, saPda, settler.publicKey);
  const saTx = new Transaction();
  saTx.add(saIx);
  saTx.recentBlockhash = svm.latestBlockhash();
  saTx.feePayer = authority.publicKey;
  saTx.sign(authority);
  svm.sendTransaction(saTx);

  const slug = slugBytes("openai");
  const [epPda] = deriveEndpointConfig(slug);
  const regIx = buildRegisterEndpoint(authority.publicKey, poolPda, epPda, slug, 500n, 0, 5000, 1000n, 5_000_000n);
  const regTx = new Transaction();
  regTx.add(regIx);
  regTx.recentBlockhash = svm.latestBlockhash();
  regTx.feePayer = authority.publicKey;
  regTx.sign(authority);
  svm.sendTransaction(regTx);

  const agent = generateKeypair(svm);
  const [walletPda] = deriveAgentWallet(agent.publicKey);
  const walletVaultKp = Keypair.generate();
  const walletIx = buildInitializeAgentWallet(agent.publicKey, walletPda, walletVaultKp.publicKey, mint, svm);
  const walletTx = new Transaction();
  walletTx.add(walletIx);
  walletTx.recentBlockhash = svm.latestBlockhash();
  walletTx.feePayer = agent.publicKey;
  walletTx.sign(agent);
  svm.sendTransaction(walletTx);

  // Fund agent wallet with 10 USDC
  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, 10_000_000n);
  const depIx = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVaultKp.publicKey, 10_000_000n);
  const depTx = new Transaction();
  depTx.add(depIx);
  depTx.recentBlockhash = svm.latestBlockhash();
  depTx.feePayer = agent.publicKey;
  depTx.sign(agent);
  svm.sendTransaction(depTx);

  // Fund pool vault for refunds
  mintTokensToAccount(svm, poolVaultKp.publicKey, 5_000_000n);
  const poolData = svm.getAccount(poolPda)!;
  const pd = new Uint8Array(poolData.data);
  new DataView(pd.buffer).setBigUint64(128, 5_000_000n, true);
  svm.setAccount(poolPda, { ...poolData, data: pd });

  // Issue a settle_batch with 1 USDC breach refund to give agent claimable balance
  const callId = new Uint8Array(16).fill(0xaa);
  const [crPda] = deriveCallRecord(callId);
  const now = Math.floor(Date.now() / 1000);
  const settleIx = buildSettleBatchIx(
    settler.publicKey, saPda, poolPda, poolVaultKp.publicKey,
    [{ callId, agentOwner: agent.publicKey, agentVault: walletVaultKp.publicKey, endpointPda: epPda, slug, premium: 500n, refund: 1_000_000n, latencyMs: 6000, breach: true, timestamp: now - 1 }],
    [crPda], [walletPda]
  );
  const settleTx = new Transaction();
  settleTx.add(settleIx);
  settleTx.recentBlockhash = svm.latestBlockhash();
  settleTx.feePayer = settler.publicKey;
  settleTx.sign(settler);
  svm.sendTransaction(settleTx);

  return {
    svm, authority, settler, mint, poolPda, poolVault: poolVaultKp.publicKey,
    saPda, slug, epPda, agent, walletPda, walletVault: walletVaultKp.publicKey, agentAta,
  };
}

test("claim_refund: partial claim transfers tokens and updates total_refunds_claimed", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();

  // Agent has 1 USDC refunded; claims 0.5 USDC
  const ix = buildClaimRefundIx(agent.publicKey, walletPda, walletVault, agentAta, 500_000n);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // owner ATA should have received 0.5 USDC
  expect(getTokenBalance(svm, agentAta)).toBe(500_000n);

  // total_refunds_claimed at offset 104 should be 500_000
  const awData = getAccountData(svm, walletPda)!;
  expect(readU64(awData, 104)).toBe(500_000n);
  // balance should have decreased by 500_000
  // balance was: 10_000_000 - 500 (premium) + 1_000_000 (refund) = 10_999_500
  expect(readU64(awData, 72)).toBe(10_999_500n - 500_000n);
});

test("claim_refund: amount > claimable rejected with error", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();

  // Agent has 1 USDC total_refunds_received, 0 claimed → claimable = 1 USDC
  // Attempt to claim 1.5 USDC → should fail
  const ix = buildClaimRefundIx(agent.publicKey, walletPda, walletVault, agentAta, 1_500_000n);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("claim_refund: non-owner rejected", () => {
  const { svm, walletPda, walletVault } = fullSetup();
  const attacker = generateKeypair(svm);
  // Create an ATA for attacker to receive tokens
  const mint = setupUsdcMint(svm, generateKeypair(svm));
  const attackerAta = createTokenAccount(svm, mint, attacker.publicKey);

  const ix = buildClaimRefundIx(attacker.publicKey, walletPda, walletVault, attackerAta, 100_000n);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("claim_refund: full claim leaves total_refunds_claimed == total_refunds_received", () => {
  const { svm, agent, walletPda, walletVault, agentAta } = fullSetup();

  // Claim the full 1 USDC refund
  const ix = buildClaimRefundIx(agent.publicKey, walletPda, walletVault, agentAta, 1_000_000n);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const awData = getAccountData(svm, walletPda)!;
  const totalReceived = readU64(awData, 96); // total_refunds_received
  const totalClaimed = readU64(awData, 104); // total_refunds_claimed
  expect(totalClaimed).toBe(totalReceived);

  // Attempting to claim 1 more lamport should now fail
  const ix2 = buildClaimRefundIx(agent.publicKey, walletPda, walletVault, agentAta, 1n);
  const tx2 = new Transaction();
  tx2.add(ix2);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = agent.publicKey;
  tx2.sign(agent);
  const result2 = svm.sendTransaction(tx2);

  expect("err" in result2).toBe(true);
});
