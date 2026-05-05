import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PROGRAM_ID,
  loadProgram, generateKeypair, setupUsdcMint,
  deriveCoveragePool, deriveSettlementAuthority, deriveEndpointConfig,
  deriveAgentWallet, deriveCallRecord, slugBytes,
  buildInitializeCoveragePool, buildInitializeSettlementAuthority,
  buildRegisterEndpoint, buildInitializeAgentWallet, buildDepositUsdc,
  createTokenAccount, mintTokensToAccount,
  getAccountData, readU64,
} from "./helpers";

// Reuse settle batch builder from test 05
function buildSettleBatchIx(
  settler: PublicKey,
  saPda: PublicKey,
  poolPda: PublicKey,
  poolVault: PublicKey,
  callId: Uint8Array,
  agentOwner: PublicKey,
  agentWalletPda: PublicKey,
  agentVault: PublicKey,
  epPda: PublicKey,
  slug: Uint8Array,
  premium: bigint,
  refund: bigint,
  breach: boolean,
  timestamp: number
): TransactionInstruction {
  const data = Buffer.alloc(1 + 2 + 100);
  data[0] = 10;
  new DataView(data.buffer).setUint16(1, 1, true);
  const off = 3;
  data.set(callId, off);
  data.set(agentOwner.toBuffer(), off + 16);
  data.set(slug, off + 48);
  new DataView(data.buffer).setBigUint64(off + 64, premium, true);
  new DataView(data.buffer).setBigUint64(off + 72, refund, true);
  new DataView(data.buffer).setUint32(off + 80, 6000, true);
  data[off + 84] = breach ? 1 : 0;
  new DataView(data.buffer).setBigInt64(off + 92, BigInt(timestamp), true);

  const [crPda] = deriveCallRecord(callId);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: settler, isSigner: true, isWritable: true },
      { pubkey: saPda, isSigner: false, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      { pubkey: crPda, isSigner: false, isWritable: true },
      { pubkey: agentWalletPda, isSigner: false, isWritable: true },
      { pubkey: agentVault, isSigner: false, isWritable: true },
      { pubkey: epPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

test("exposure cap: third batch refund zeroed when cap exceeded", () => {
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

  // Register endpoint with exposure_cap = 1_000_000 (1 USDC)
  const slug = slugBytes("jupiter");
  const [epPda] = deriveEndpointConfig(slug);
  const regIx = buildRegisterEndpoint(authority.publicKey, poolPda, epPda, slug, 500n, 0, 3000, 1000n, 1_000_000n);
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

  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, 25_000_000n);
  const depIx = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVaultKp.publicKey, 25_000_000n);
  const depTx = new Transaction();
  depTx.add(depIx);
  depTx.recentBlockhash = svm.latestBlockhash();
  depTx.feePayer = agent.publicKey;
  depTx.sign(agent);
  svm.sendTransaction(depTx);

  // Fund pool vault
  mintTokensToAccount(svm, poolVaultKp.publicKey, 5_000_000n);
  const poolAcct = svm.getAccount(poolPda)!;
  const pd = new Uint8Array(poolAcct.data);
  new DataView(pd.buffer).setBigUint64(128, 5_000_000n, true);
  svm.setAccount(poolPda, { ...poolAcct, data: pd });

  const now = Math.floor(Date.now() / 1000);

  // Batch 1: refund 600_000 (within cap)
  const id1 = new Uint8Array(16).fill(10);
  const ix1 = buildSettleBatchIx(settler.publicKey, saPda, poolPda, poolVaultKp.publicKey, id1, agent.publicKey, walletPda, walletVaultKp.publicKey, epPda, slug, 500n, 600_000n, true, now - 3);
  const tx1 = new Transaction();
  tx1.add(ix1);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = settler.publicKey;
  tx1.sign(settler);
  expect(svm.sendTransaction(tx1) instanceof FailedTransactionMetadata).toBe(false);

  // Batch 2: refund 500_000 (still within cap: 600k+500k>1M but cap remaining = 400k, so zeroed)
  // Actually: 600k already used, cap=1M, remaining=400k, refund=500k > 400k → zeroed
  const id2 = new Uint8Array(16).fill(11);
  const ix2 = buildSettleBatchIx(settler.publicKey, saPda, poolPda, poolVaultKp.publicKey, id2, agent.publicKey, walletPda, walletVaultKp.publicKey, epPda, slug, 500n, 500_000n, true, now - 2);
  const tx2 = new Transaction();
  tx2.add(ix2);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = settler.publicKey;
  tx2.sign(settler);
  expect("err" in svm.sendTransaction(tx2)).toBe(false);

  // After batch 2, check agent refunds received = only first batch's 600k
  const awData2 = getAccountData(svm, walletPda)!;
  expect(readU64(awData2, 96)).toBe(600_000n); // only first batch credited
});

test("exposure cap resets after 1 hour", () => {
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

  const slug = slugBytes("elfa");
  const [epPda] = deriveEndpointConfig(slug);
  const regIx = buildRegisterEndpoint(authority.publicKey, poolPda, epPda, slug, 500n, 0, 3000, 1000n, 500_000n);
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

  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, 25_000_000n);
  const depIx = buildDepositUsdc(agent.publicKey, walletPda, agentAta, walletVaultKp.publicKey, 25_000_000n);
  const depTx = new Transaction();
  depTx.add(depIx);
  depTx.recentBlockhash = svm.latestBlockhash();
  depTx.feePayer = agent.publicKey;
  depTx.sign(agent);
  svm.sendTransaction(depTx);

  mintTokensToAccount(svm, poolVaultKp.publicKey, 5_000_000n);
  const poolAcct = svm.getAccount(poolPda)!;
  const pd = new Uint8Array(poolAcct.data);
  new DataView(pd.buffer).setBigUint64(128, 5_000_000n, true);
  svm.setAccount(poolPda, { ...poolAcct, data: pd });

  const now = Math.floor(Date.now() / 1000);

  // Use full 500k cap
  const id1 = new Uint8Array(16).fill(20);
  const ix1 = buildSettleBatchIx(settler.publicKey, saPda, poolPda, poolVaultKp.publicKey, id1, agent.publicKey, walletPda, walletVaultKp.publicKey, epPda, slug, 500n, 500_000n, true, now - 2);
  const tx1 = new Transaction();
  tx1.add(ix1);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = settler.publicKey;
  tx1.sign(settler);
  svm.sendTransaction(tx1);

  // Advance clock by 2 hours
  const clock = svm.getClock();
  svm.setClock(new Clock(
    clock.slot + 7200n,
    clock.epochStartTimestamp,
    clock.epoch,
    clock.leaderScheduleEpoch,
    clock.unixTimestamp + 7200n
  ));

  // Now send another 500k refund — cap should have reset
  const id2 = new Uint8Array(16).fill(21);
  const futureNow = now + 7200;
  const ix2 = buildSettleBatchIx(settler.publicKey, saPda, poolPda, poolVaultKp.publicKey, id2, agent.publicKey, walletPda, walletVaultKp.publicKey, epPda, slug, 500n, 500_000n, true, futureNow - 1);
  const tx2 = new Transaction();
  tx2.add(ix2);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = settler.publicKey;
  tx2.sign(settler);
  const result = svm.sendTransaction(tx2);

  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Both batches credited = 1_000_000 total
  const awData = getAccountData(svm, walletPda)!;
  expect(readU64(awData, 96)).toBe(1_000_000n);
});
