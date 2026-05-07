import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  loadProgram,
  generateKeypair,
  setupUsdcMint,
  deriveProtocolConfig,
  deriveTreasury,
  buildInitializeProtocolConfig,
  FEE_KIND_TREASURY,
  FEE_KIND_AFFILIATE_ATA,
  getAccountData,
  readU16,
} from "./helpers";

test("initialize_protocol_config happy path with default Treasury entry", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const [treasuryPda] = deriveTreasury();

  const ix = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    defaultRecipients: [
      { kind: FEE_KIND_TREASURY, destination: treasuryPda, bps: 1000 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);
  if ("err" in result) console.log("INIT PC ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(svm, pcPda);
  expect(data).not.toBeNull();
  // bump (1) + pad (7) + authority (32 @ 8) + usdc_mint (32 @ 40)
  // + max_total_fee_bps (u16 @ 72) + default_count (u8 @ 74)
  expect(readU16(data!, 72)).toBe(3000); // default cap
  expect(data![74]).toBe(1); // recipient count
});

test("initialize_protocol_config double-init rejected", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const [treasuryPda] = deriveTreasury();

  const ix = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    defaultRecipients: [
      { kind: FEE_KIND_TREASURY, destination: treasuryPda, bps: 1000 },
    ],
  });
  // First init succeeds.
  const t1 = new Transaction();
  t1.add(ix);
  t1.recentBlockhash = svm.latestBlockhash();
  t1.feePayer = authority.publicKey;
  t1.sign(authority);
  expect(svm.sendTransaction(t1) instanceof FailedTransactionMetadata).toBe(false);
  // Second init fails.
  const t2 = new Transaction();
  t2.add(ix);
  t2.recentBlockhash = svm.latestBlockhash();
  t2.feePayer = authority.publicKey;
  t2.sign(authority);
  expect(svm.sendTransaction(t2) instanceof FailedTransactionMetadata).toBe(true);
});

test("initialize_protocol_config rejects sum > 10000 bps", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const [treasuryPda] = deriveTreasury();
  const someAffiliate = generateKeypair(svm).publicKey;

  // 9000 + 2000 = 11000 > 10000
  const ix = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    maxTotalFeeBpsPresent: true,
    maxTotalFeeBps: 11000, // bypass cap so we trip the absolute 10k check
    defaultRecipients: [
      { kind: FEE_KIND_TREASURY, destination: treasuryPda, bps: 9000 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: someAffiliate, bps: 2000 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  expect(svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("initialize_protocol_config rejects duplicate destinations", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const dup = generateKeypair(svm).publicKey;

  const ix = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    defaultRecipients: [
      { kind: FEE_KIND_AFFILIATE_ATA, destination: dup, bps: 500 },
      { kind: FEE_KIND_AFFILIATE_ATA, destination: dup, bps: 200 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  expect(svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});

test("initialize_protocol_config rejects multiple Treasury entries", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const [treasuryPda] = deriveTreasury();
  const otherTreasury = generateKeypair(svm).publicKey;

  const ix = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    defaultRecipients: [
      { kind: FEE_KIND_TREASURY, destination: treasuryPda, bps: 500 },
      { kind: FEE_KIND_TREASURY, destination: otherTreasury, bps: 500 },
    ],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  expect(svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
