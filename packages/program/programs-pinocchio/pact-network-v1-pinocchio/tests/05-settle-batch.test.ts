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
  getAccountData, readU64, readI64,
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
    { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // clock sysvar placeholder
  ];

  for (let i = 0; i < events.length; i++) {
    keys.push({ pubkey: callRecordPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: agentWalletPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].agentVault, isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].endpointPda, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: fullData });
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

  const slug = slugBytes("helius");
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

  // Fund agent wallet
  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, 10_000_000n);
  const depIx = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVaultKp.publicKey, 10_000_000n);
  const depTx = new Transaction();
  depTx.add(depIx);
  depTx.recentBlockhash = svm.latestBlockhash();
  depTx.feePayer = agent.publicKey;
  depTx.sign(agent);
  svm.sendTransaction(depTx);

  // Fund pool vault (for refunds)
  mintTokensToAccount(svm, poolVaultKp.publicKey, 5_000_000n);
  // Update pool state current_balance
  const poolData = svm.getAccount(poolPda)!;
  const pd = new Uint8Array(poolData.data);
  new DataView(pd.buffer).setBigUint64(128, 5_000_000n, true);
  svm.setAccount(poolPda, { ...poolData, data: pd });

  return {
    svm, authority, settler, mint, poolPda, poolVault: poolVaultKp.publicKey,
    saPda, slug, epPda, agent, walletPda, walletVault: walletVaultKp.publicKey,
  };
}

test("settle_batch single no-breach: premium debited from agent, CallRecord created", () => {
  const { svm, settler, poolPda, poolVault, saPda, slug, epPda, agent, walletPda, walletVault } = fullSetup();

  const callId = new Uint8Array(16).fill(1);
  const [crPda] = deriveCallRecord(callId);
  const now = Math.floor(Date.now() / 1000);

  const ix = buildSettleBatchIx(
    settler.publicKey, saPda, poolPda, poolVault,
    [{ callId, agentOwner: agent.publicKey, agentVault: walletVault, endpointPda: epPda, slug, premium: 500n, refund: 0n, latencyMs: 100, breach: false, timestamp: now - 1 }],
    [crPda], [walletPda]
  );

  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Agent balance decreased by premium
  const awData = getAccountData(svm, walletPda)!;
  expect(readU64(awData, 72)).toBe(10_000_000n - 500n); // balance

  // Pool current_balance increased by premium
  const poolData = getAccountData(svm, poolPda)!;
  expect(readU64(poolData, 128)).toBe(5_000_000n + 500n);

  // CallRecord exists
  const crData = getAccountData(svm, crPda);
  expect(crData).not.toBeNull();
});

test("settle_batch with breach: refund credited to agent", () => {
  const { svm, settler, poolPda, poolVault, saPda, slug, epPda, agent, walletPda, walletVault } = fullSetup();

  const callId = new Uint8Array(16).fill(2);
  const [crPda] = deriveCallRecord(callId);
  const now = Math.floor(Date.now() / 1000);

  const ix = buildSettleBatchIx(
    settler.publicKey, saPda, poolPda, poolVault,
    [{ callId, agentOwner: agent.publicKey, agentVault: walletVault, endpointPda: epPda, slug, premium: 500n, refund: 1000n, latencyMs: 6000, breach: true, timestamp: now - 1 }],
    [crPda], [walletPda]
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const awData = getAccountData(svm, walletPda)!;
  // balance = 10_000_000 - 500 (premium) + 1000 (refund) = 10_000_500
  expect(readU64(awData, 72)).toBe(10_000_000n - 500n + 1000n);
  // total_refunds_received = 1000
  expect(readU64(awData, 96)).toBe(1000n);
});

test("settle_batch duplicate call_id rejected", () => {
  const { svm, settler, poolPda, poolVault, saPda, slug, epPda, agent, walletPda, walletVault } = fullSetup();

  const callId = new Uint8Array(16).fill(3);
  const [crPda] = deriveCallRecord(callId);
  const now = Math.floor(Date.now() / 1000);
  const event = { callId, agentOwner: agent.publicKey, agentVault: walletVault, endpointPda: epPda, slug, premium: 500n, refund: 0n, latencyMs: 100, breach: false, timestamp: now - 1 };

  for (let i = 0; i < 2; i++) {
    const ix = buildSettleBatchIx(settler.publicKey, saPda, poolPda, poolVault, [event], [crPda], [walletPda]);
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = settler.publicKey;
    tx.sign(settler);
    const result = svm.sendTransaction(tx);
    if (i === 0) expect(result instanceof FailedTransactionMetadata).toBe(false);
    else expect(result instanceof FailedTransactionMetadata).toBe(true);
  }
});

test("settle_batch unauthorized settler rejected", () => {
  const { svm, poolPda, poolVault, saPda, slug, epPda, agent, walletPda, walletVault } = fullSetup();
  const badSettler = generateKeypair(svm);

  const callId = new Uint8Array(16).fill(4);
  const [crPda] = deriveCallRecord(callId);
  const now = Math.floor(Date.now() / 1000);

  const ix = buildSettleBatchIx(
    badSettler.publicKey, saPda, poolPda, poolVault,
    [{ callId, agentOwner: agent.publicKey, agentVault: walletVault, endpointPda: epPda, slug, premium: 500n, refund: 0n, latencyMs: 100, breach: false, timestamp: now - 1 }],
    [crPda], [walletPda]
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = badSettler.publicKey;
  tx.sign(badSettler);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("settle_batch future timestamp rejected", () => {
  const { svm, settler, poolPda, poolVault, saPda, slug, epPda, agent, walletPda, walletVault } = fullSetup();
  const callId = new Uint8Array(16).fill(5);
  const [crPda] = deriveCallRecord(callId);
  const futureTs = Math.floor(Date.now() / 1000) + 9999;

  const ix = buildSettleBatchIx(
    settler.publicKey, saPda, poolPda, poolVault,
    [{ callId, agentOwner: agent.publicKey, agentVault: walletVault, endpointPda: epPda, slug, premium: 500n, refund: 0n, latencyMs: 100, breach: false, timestamp: futureTs }],
    [crPda], [walletPda]
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
});
