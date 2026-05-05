import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  setupProtocolAndTreasury,
  registerSimpleEndpoint,
  buildTopUpCoveragePool,
  deriveCoveragePool,
  slugBytes,
  createTokenAccount,
  mintTokensToAccount,
  getTokenBalance,
  getAccountData,
  readU64,
} from "./helpers";

test("register_endpoint creates per-slug coverage pool with correct state", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");

  const data = getAccountData(base.svm, ep.poolPda);
  expect(data).not.toBeNull();
  // bump (1) + pad (7) + authority @ 8 + mint @ 40 + vault @ 72 + slug @ 104 +
  // total_deposits @ 120 + total_premiums @ 128 + total_refunds @ 136 +
  // current_balance @ 144 + created_at @ 152
  expect(data![0]).toBeGreaterThan(0); // bump nonzero
  // authority
  expect(Buffer.from(data!.slice(8, 40)).toString("hex")).toBe(
    base.authority.publicKey.toBuffer().toString("hex"),
  );
  // slug
  expect(Buffer.from(data!.slice(104, 120))).toEqual(Buffer.from(ep.slug));
  expect(readU64(data!, 120)).toBe(0n); // total_deposits
  expect(readU64(data!, 144)).toBe(0n); // current_balance
});

test("two endpoints have isolated coverage pools at distinct PDAs", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const epA = registerSimpleEndpoint(base, "helius");
  const epB = registerSimpleEndpoint(base, "jupiter");

  expect(epA.poolPda.toString()).not.toBe(epB.poolPda.toString());
  expect(epA.poolVault.toString()).not.toBe(epB.poolVault.toString());

  // Both pool accounts exist independently.
  expect(getAccountData(base.svm, epA.poolPda)).not.toBeNull();
  expect(getAccountData(base.svm, epB.poolPda)).not.toBeNull();

  // Both endpoints reference their own slug-derived pool.
  const [expectedA] = deriveCoveragePool(slugBytes("helius"));
  const [expectedB] = deriveCoveragePool(slugBytes("jupiter"));
  expect(epA.poolPda.equals(expectedA)).toBe(true);
  expect(epB.poolPda.equals(expectedB)).toBe(true);
});

test("top_up_coverage_pool credits only the targeted slug pool", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const epA = registerSimpleEndpoint(base, "helius");
  const epB = registerSimpleEndpoint(base, "jupiter");

  // Authority funds an ATA + tops up endpoint A.
  const authAta = createTokenAccount(base.svm, base.mint, base.authority.publicKey);
  mintTokensToAccount(base.svm, authAta, 1_000_000n);

  const ix = buildTopUpCoveragePool({
    authority: base.authority.publicKey,
    poolPda: epA.poolPda,
    authorityAta: authAta,
    poolVault: epA.poolVault,
    slug: epA.slug,
    amount: 500_000n,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("TOPUP ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // A's pool current_balance updated; A's vault has the tokens; B untouched.
  const aPool = getAccountData(base.svm, epA.poolPda)!;
  expect(readU64(aPool, 144)).toBe(500_000n);
  expect(getTokenBalance(base.svm, epA.poolVault)).toBe(500_000n);

  const bPool = getAccountData(base.svm, epB.poolPda)!;
  expect(readU64(bPool, 144)).toBe(0n);
  expect(getTokenBalance(base.svm, epB.poolVault)).toBe(0n);
});

test("top_up rejects mismatched pool/slug pair (slug seed != pool PDA)", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const epA = registerSimpleEndpoint(base, "helius");
  const _epB = registerSimpleEndpoint(base, "jupiter");

  const authAta = createTokenAccount(base.svm, base.mint, base.authority.publicKey);
  mintTokensToAccount(base.svm, authAta, 1_000_000n);

  // Pass A's pool but B's slug — derived pool from B's slug != A's pool PDA.
  const ix = buildTopUpCoveragePool({
    authority: base.authority.publicKey,
    poolPda: epA.poolPda,
    authorityAta: authAta,
    poolVault: epA.poolVault,
    slug: slugBytes("jupiter"),
    amount: 500_000n,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
