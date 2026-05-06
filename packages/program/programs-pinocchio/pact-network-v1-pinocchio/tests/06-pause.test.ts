import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Transaction } from "@solana/web3.js";
import {
  setupProtocolAndTreasury,
  registerSimpleEndpoint,
  buildPauseEndpoint,
  generateKeypair,
  getAccountData,
} from "./helpers";

test("pause_endpoint sets paused flag", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "birdeye");
  const ix = buildPauseEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    endpointPda: ep.endpointPda,
    paused: true,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) console.log("PAUSE ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  const data = getAccountData(base.svm, ep.endpointPda)!;
  expect(data[1]).toBe(1);
});

test("pause_endpoint can unpause", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "birdeye");
  for (const paused of [true, false]) {
    const ix = buildPauseEndpoint({
      authority: base.authority.publicKey,
      pcPda: base.pcPda,
      endpointPda: ep.endpointPda,
      paused,
    });
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = base.svm.latestBlockhash();
    tx.feePayer = base.authority.publicKey;
    tx.sign(base.authority);
    base.svm.sendTransaction(tx);
  }
  const data = getAccountData(base.svm, ep.endpointPda)!;
  expect(data[1]).toBe(0);
});

test("pause_endpoint rejected for non-authority", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "birdeye");
  const attacker = generateKeypair(base.svm);
  const ix = buildPauseEndpoint({
    authority: attacker.publicKey,
    pcPda: base.pcPda,
    endpointPda: ep.endpointPda,
    paused: true,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
