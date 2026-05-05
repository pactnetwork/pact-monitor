import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  setupProtocolAndTreasury,
  registerSimpleEndpoint,
  setupSettlementAuthority,
  buildSettleBatch,
  fundPoolDirect,
  generateKeypair,
  createTokenAccount,
  mintTokensToAccount,
  setTokenDelegate,
  clearTokenDelegate,
  getTokenBalance,
  deriveSettlementAuthority,
  deriveCallRecord,
  deriveCoveragePool,
  slugBytes,
  FEE_KIND_TREASURY,
  FEE_KIND_AFFILIATE_ATA,
  getAccountData,
  readU64,
  SettleEvent,
} from "./helpers";

/**
 * Provision an agent: fund their USDC ATA and bake a delegate of the
 * SettlementAuthority PDA so the program can pull premiums on their behalf.
 *
 * SPL Token's `Approve` instruction is the production path; in LiteSVM we
 * write the delegate fields directly into the token-account buffer to avoid
 * standing up a full SPL Token CPI. This is faithful to what `Approve`
 * produces and to what the program reads at settle time.
 */
function provisionAgent(svm: LiteSVM, mint: PublicKey, saPda: PublicKey, balance: bigint, delegated: bigint): { agent: Keypair; agentAta: PublicKey } {
  const agent = generateKeypair(svm);
  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, balance);
  setTokenDelegate(svm, agentAta, saPda, delegated);
  return { agent, agentAta };
}

test("single event with default 10% Treasury fan-out: balances split correctly", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);

  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);

  // Pre-fund the pool so it can refund / pay fees out of vault liquidity.
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const callId = new Uint8Array(16).fill(1);
  const now = Math.floor(Date.now() / 1000);
  const premium = 10_000n; // 10% = 1000

  const ix = buildSettleBatch(settler.publicKey, saPda, [
    {
      callId,
      agentOwner: agent.publicKey,
      agentAta,
      endpointPda: ep.endpointPda,
      poolPda: ep.poolPda,
      poolVault: ep.poolVault,
      slug: ep.slug,
      premium,
      refund: 0n,
      latencyMs: 100,
      breach: false,
      timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("SETTLE ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Agent ATA: dropped by full premium.
  expect(getTokenBalance(base.svm, agentAta)).toBe(10_000_000n - premium);
  // Pool vault: gross-credited 10_000, fee-debited 1_000, net +9_000 over the 5M baseline.
  expect(getTokenBalance(base.svm, ep.poolVault)).toBe(5_000_000n + 9_000n);
  // Treasury vault: 10% of premium = 1000.
  expect(getTokenBalance(base.svm, base.treasuryVault)).toBe(1_000n);

  // CallRecord exists.
  const [crPda] = deriveCallRecord(callId);
  expect(getAccountData(base.svm, crPda)).not.toBeNull();
});

test("single event with explicit Treasury 10% + Affiliate 5%: split = 85/10/5", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  // Affiliate ATA needs to exist as a USDC token account.
  const affOwner = generateKeypair(base.svm);
  const affAta = createTokenAccount(base.svm, base.mint, affOwner.publicKey);
  const ep = registerSimpleEndpoint(base, "jupiter", {
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 1000 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: affAta, bps: 500 },
    ],
  });
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const callId = new Uint8Array(16).fill(2);
  const now = Math.floor(Date.now() / 1000);
  const premium = 100_000n;

  const ix = buildSettleBatch(settler.publicKey, saPda, [
    {
      callId,
      agentOwner: agent.publicKey,
      agentAta,
      endpointPda: ep.endpointPda,
      poolPda: ep.poolPda,
      poolVault: ep.poolVault,
      slug: ep.slug,
      premium,
      refund: 0n,
      latencyMs: 100,
      breach: false,
      timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault, affAta],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("SETTLE85 ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Treasury credited 10%, Affiliate 5%.
  expect(getTokenBalance(base.svm, base.treasuryVault)).toBe(10_000n);
  expect(getTokenBalance(base.svm, affAta)).toBe(5_000n);
  // Pool retains 85% = 85_000.
  expect(getTokenBalance(base.svm, ep.poolVault)).toBe(5_000_000n + 85_000n);
  // Agent ATA debited full premium.
  expect(getTokenBalance(base.svm, agentAta)).toBe(10_000_000n - 100_000n);
});

test("breach event refunds agent ATA directly from pool vault", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const callId = new Uint8Array(16).fill(3);
  const now = Math.floor(Date.now() / 1000);
  const premium = 1_000n;
  const refund = 50_000n;

  const ix = buildSettleBatch(settler.publicKey, saPda, [
    {
      callId,
      agentOwner: agent.publicKey,
      agentAta,
      endpointPda: ep.endpointPda,
      poolPda: ep.poolPda,
      poolVault: ep.poolVault,
      slug: ep.slug,
      premium,
      refund,
      latencyMs: 6000,
      breach: true,
      timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("SETTLE BREACH ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Agent: -premium + refund.
  expect(getTokenBalance(base.svm, agentAta)).toBe(10_000_000n - premium + refund);
  // Pool: +premium - 100bps treasury fee - refund.
  // 100 bps of 1000 = 100. So pool = 5_000_000 + 1000 - 100 - 50_000 = 4_950_900
  expect(getTokenBalance(base.svm, ep.poolVault)).toBe(5_000_000n + 1_000n - 100n - 50_000n);
});

test("mixed batch across 3 endpoints with different fee templates", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);

  // EP1: defaults (Treasury 10%)
  const ep1 = registerSimpleEndpoint(base, "ep1");
  fundPoolDirect(base.svm, ep1.poolPda, ep1.poolVault, 1_000_000n);

  // EP2: Treasury 5% + Affiliate 5% (sum 10% under default 30% cap)
  const aff2Owner = generateKeypair(base.svm);
  const aff2Ata = createTokenAccount(base.svm, base.mint, aff2Owner.publicKey);
  const ep2 = registerSimpleEndpoint(base, "ep2", {
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 500 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff2Ata, bps: 500 },
    ],
  });
  fundPoolDirect(base.svm, ep2.poolPda, ep2.poolVault, 1_000_000n);

  // EP3: empty fee_recipients -> 100% pool retention
  const ep3 = registerSimpleEndpoint(base, "ep3", { recipientsOverride: [] });
  fundPoolDirect(base.svm, ep3.poolPda, ep3.poolVault, 1_000_000n);

  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 30_000_000n, 30_000_000n);

  const now = Math.floor(Date.now() / 1000);
  const premiums = [100_000n, 200_000n, 300_000n];
  const events: SettleEvent[] = [
    {
      callId: new Uint8Array(16).fill(11),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep1.endpointPda, poolPda: ep1.poolPda, poolVault: ep1.poolVault, slug: ep1.slug,
      premium: premiums[0], refund: 0n, latencyMs: 50, breach: false, timestamp: now - 3,
      feeRecipientAtas: [base.treasuryVault],
    },
    {
      callId: new Uint8Array(16).fill(12),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep2.endpointPda, poolPda: ep2.poolPda, poolVault: ep2.poolVault, slug: ep2.slug,
      premium: premiums[1], refund: 0n, latencyMs: 50, breach: false, timestamp: now - 2,
      feeRecipientAtas: [base.treasuryVault, aff2Ata],
    },
    {
      callId: new Uint8Array(16).fill(13),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep3.endpointPda, poolPda: ep3.poolPda, poolVault: ep3.poolVault, slug: ep3.slug,
      premium: premiums[2], refund: 0n, latencyMs: 50, breach: false, timestamp: now - 1,
      feeRecipientAtas: [],
    },
  ];

  const ix = buildSettleBatch(settler.publicKey, saPda, events);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("MIX ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Agent debited 100k+200k+300k = 600k.
  expect(getTokenBalance(base.svm, agentAta)).toBe(30_000_000n - 600_000n);
  // EP1 pool: +100k - 10k (Treasury) = +90k.
  expect(getTokenBalance(base.svm, ep1.poolVault)).toBe(1_000_000n + 90_000n);
  // EP2 pool: +200k - 10k (Treasury 5%) - 10k (Aff 5%) = +180k.
  expect(getTokenBalance(base.svm, ep2.poolVault)).toBe(1_000_000n + 180_000n);
  // EP3 pool: +300k (no recipients) = +300k.
  expect(getTokenBalance(base.svm, ep3.poolVault)).toBe(1_000_000n + 300_000n);
  // Treasury credited (10k from ep1 + 10k from ep2) = 20k.
  expect(getTokenBalance(base.svm, base.treasuryVault)).toBe(20_000n);
  // Affiliate2 credited 10k.
  expect(getTokenBalance(base.svm, aff2Ata)).toBe(10_000n);
});

test("revoke between events: subsequent settle for that agent fails", () => {
  // LiteSVM-friendly variant of "revoke mid-batch": send two separate
  // settle_batch txs. Between them we Revoke the agent's delegate; the
  // second tx must fail because SPL Token's Transfer with delegate
  // authority verifies delegate equals authority.
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const now = Math.floor(Date.now() / 1000);
  // First event succeeds.
  const ix1 = buildSettleBatch(settler.publicKey, saPda, [
    {
      callId: new Uint8Array(16).fill(20),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
      premium: 1_000n, refund: 0n, latencyMs: 50, breach: false, timestamp: now - 2,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const t1 = new Transaction();
  t1.add(ix1);
  t1.recentBlockhash = base.svm.latestBlockhash();
  t1.feePayer = settler.publicKey;
  t1.sign(settler);
  expect(base.svm.sendTransaction(t1) instanceof FailedTransactionMetadata).toBe(false);

  // Revoke between batches.
  clearTokenDelegate(base.svm, agentAta);

  // Second event must fail (delegate cleared → SPL Token Transfer w/ delegate authority rejects).
  const ix2 = buildSettleBatch(settler.publicKey, saPda, [
    {
      callId: new Uint8Array(16).fill(21),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
      premium: 1_000n, refund: 0n, latencyMs: 50, breach: false, timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const t2 = new Transaction();
  t2.add(ix2);
  t2.recentBlockhash = base.svm.latestBlockhash();
  t2.feePayer = settler.publicKey;
  t2.sign(settler);
  expect(base.svm.sendTransaction(t2) instanceof FailedTransactionMetadata).toBe(true);
});

test("min-premium edge: premium < MIN_PREMIUM_LAMPORTS rejected", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const now = Math.floor(Date.now() / 1000);
  const ix = buildSettleBatch(settler.publicKey, saPda, [
    {
      callId: new Uint8Array(16).fill(30),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
      premium: 50n, // < 100 = MIN_PREMIUM_LAMPORTS
      refund: 0n, latencyMs: 50, breach: false, timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = settler.publicKey;
  tx.sign(settler);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("duplicate call_id rejected", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const now = Math.floor(Date.now() / 1000);
  const event: SettleEvent = {
    callId: new Uint8Array(16).fill(40),
    agentOwner: agent.publicKey, agentAta,
    endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
    premium: 1_000n, refund: 0n, latencyMs: 50, breach: false, timestamp: now - 1,
    feeRecipientAtas: [base.treasuryVault],
  };
  for (let i = 0; i < 2; i++) {
    const ix = buildSettleBatch(settler.publicKey, saPda, [event]);
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = base.svm.latestBlockhash();
    tx.feePayer = settler.publicKey;
    tx.sign(settler);
    const result = base.svm.sendTransaction(tx);
    if (i === 0) expect(result instanceof FailedTransactionMetadata).toBe(false);
    else expect(result instanceof FailedTransactionMetadata).toBe(true);
  }
});

test("unauthorized settler rejected", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(base.svm, base.mint, saPda, 10_000_000n, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const fake = generateKeypair(base.svm);
  const now = Math.floor(Date.now() / 1000);
  const ix = buildSettleBatch(fake.publicKey, saPda, [
    {
      callId: new Uint8Array(16).fill(50),
      agentOwner: agent.publicKey, agentAta,
      endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
      premium: 1_000n, refund: 0n, latencyMs: 50, breach: false, timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = fake.publicKey;
  tx.sign(fake);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
