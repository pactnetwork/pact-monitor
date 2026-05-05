import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  setupProtocolAndTreasury,
  registerSimpleEndpoint,
  buildRegisterEndpoint,
  buildUpdateFeeRecipients,
  buildUpdateEndpointConfig,
  createTokenAccount,
  deriveEndpointConfig,
  deriveCoveragePool,
  slugBytes,
  generateKeypair,
  FEE_KIND_TREASURY,
  FEE_KIND_AFFILIATE_ATA,
  getAccountData,
  readU16,
  readU64,
  PublicKey,
} from "./helpers";

test("register_endpoint with explicit recipients writes them onto endpoint", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const affOwner = generateKeypair(base.svm);
  const affiliate = createTokenAccount(base.svm, base.mint, affOwner.publicKey);
  const ep = registerSimpleEndpoint(base, "helius", {
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 1000 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: affiliate, bps: 500 },
    ],
    affiliateAtas: [affiliate],
  });

  const data = getAccountData(base.svm, ep.endpointPda);
  expect(data).not.toBeNull();
  // EndpointConfig new layout — fee_recipient_count lives just after the
  // legacy 152-byte head + 32-byte coverage_pool field, i.e. at byte 152.
  // Layout sanity: bump@0 paused@1 pad@2..7 slug@8 flat@24 percent@32
  //   pad@34 sla@40 pad@44 imputed@48 cap@56 period_start@64 period_refunds@72
  //   total_calls@80 breaches@88 premiums@96 refunds@104 last_updated@112
  //   coverage_pool@120 (32) → fee_recipient_count@152
  expect(data![152]).toBe(2);
  // First entry begins at 160 (count + pad8). kind=Treasury (0), bps=1000 at offset 200.
  expect(data![160]).toBe(FEE_KIND_TREASURY);
  expect(readU16(data!, 200)).toBe(1000);
  // Second entry at 160+48=208. kind=AffiliateAta (1) bps=500 at 248.
  expect(data![208]).toBe(FEE_KIND_AFFILIATE_ATA);
  expect(readU16(data!, 248)).toBe(500);
});

test("register_endpoint with default template copies from ProtocolConfig", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");

  const data = getAccountData(base.svm, ep.endpointPda);
  expect(data).not.toBeNull();
  expect(data![152]).toBe(1); // count from default = 1 (Treasury 1000bps)
  expect(data![160]).toBe(FEE_KIND_TREASURY);
  expect(readU16(data!, 200)).toBe(1000);
});

test("register_endpoint rejects sum > 10000 bps", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("bad-sum");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const aff1 = generateKeypair(base.svm).publicKey;
  const aff2 = generateKeypair(base.svm).publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff1, bps: 6000 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff2, bps: 6000 }, // sum 12000
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects sum > max_total_fee_bps cap (3000 default)", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("over-cap");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const aff = generateKeypair(base.svm).publicKey;
  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      // Sum 4000 > 3000 default max_total_fee_bps.
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff, bps: 4000 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects duplicate destination", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("dup");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;
  const aff = generateKeypair(base.svm).publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff, bps: 500 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff, bps: 500 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects multiple Treasury entries", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("two-tre");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 500 },
      { kind: FEE_KIND_TREASURY, destination: generateKeypair(base.svm).publicKey, bps: 500 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects non-ProtocolConfig-authority caller", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const attacker = generateKeypair(base.svm);
  const slug = slugBytes("hax");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const ix = buildRegisterEndpoint({
    authority: attacker.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("update_fee_recipients atomically replaces array + same validations", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const affOwner = generateKeypair(base.svm);
  const aff = createTokenAccount(base.svm, base.mint, affOwner.publicKey);

  const ix = buildUpdateFeeRecipients({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda: ep.endpointPda,
    slug: ep.slug,
    recipients: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 800 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff, bps: 200 },
    ],
    affiliateAtas: [aff],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("UPDATE ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(base.svm, ep.endpointPda)!;
  expect(data[152]).toBe(2);
  expect(readU16(data, 200)).toBe(800); // first entry bps updated
  expect(readU16(data, 248)).toBe(200);

  // Now reject a bad update (sum > 10000).
  const bad = buildUpdateFeeRecipients({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda: ep.endpointPda,
    slug: ep.slug,
    recipients: [
      { kind: FEE_KIND_AFFILIATE_ATA, destination: aff, bps: 11_000 },
    ],
    affiliateAtas: [aff],
  });
  const txBad = new Transaction();
  txBad.add(bad);
  txBad.recentBlockhash = base.svm.latestBlockhash();
  txBad.feePayer = base.authority.publicKey;
  txBad.sign(base.authority);
  expect(base.svm.sendTransaction(txBad) instanceof FailedTransactionMetadata).toBe(true);
});

test("update_endpoint_config updates flat_premium only", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");

  const ix = buildUpdateEndpointConfig({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    endpointPda: ep.endpointPda,
    flatPremium: 999n,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("UPDATE EP ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(base.svm, ep.endpointPda)!;
  expect(readU64(data, 24)).toBe(999n);
});

// ---------------------------------------------------------------------------
// Codex 2026-05-05 review fix: tightened fee-recipient validation.
// ---------------------------------------------------------------------------

test("register_endpoint rejects zero-entry recipients (missing Treasury)", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("no-tre");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [], // no Treasury entry → rejected
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects Treasury bps = 0", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("zero-tre");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 0 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects AffiliateAta == Treasury vault post-substitution", () => {
  // The on-wire Treasury entry has its destination ignored (substituted to
  // base.treasuryVault at register time). Without post-substitution dup
  // detection a caller could smuggle an AffiliateAta pointing at the
  // Treasury vault and double-count fees. Codex 2026-05-05 fix: dup check
  // re-runs after substitution.
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("smuggle");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 500 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: base.treasuryVault, bps: 500 },
    ],
    affiliateAtas: [base.treasuryVault],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("register_endpoint rejects AffiliateAta with bare-pubkey (non-token) destination", () => {
  // Caller passes a system-owned wallet pubkey instead of a real USDC ATA.
  // Codex 2026-05-05 fix: validate_affiliate_atas rejects.
  const base = setupProtocolAndTreasury(new LiteSVM());
  const slug = slugBytes("bad-ata");
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const bareWallet = generateKeypair(base.svm).publicKey; // system-owned
  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: 500n,
    percentBps: 0,
    slaMs: 5000,
    imputedCost: 1000n,
    exposureCap: 5_000_000n,
    recipientsOverride: [
      { kind: FEE_KIND_TREASURY, destination: PublicKey.default, bps: 1000 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: bareWallet, bps: 500 },
    ],
    affiliateAtas: [bareWallet],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
