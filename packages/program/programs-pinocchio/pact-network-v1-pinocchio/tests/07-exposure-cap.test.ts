import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { Keypair, Transaction } from "@solana/web3.js";
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
  getTokenBalance,
} from "./helpers";

function provisionAgent(svm: LiteSVM, mint: any, saPda: any, balance: bigint) {
  const agent = generateKeypair(svm);
  const agentAta = createTokenAccount(svm, mint, agent.publicKey);
  mintTokensToAccount(svm, agentAta, balance);
  setTokenDelegate(svm, agentAta, saPda, balance);
  return { agent, agentAta };
}

test("exposure cap: refund zeroed when remaining cap exceeded", () => {
  const svm = new LiteSVM();
  const base = setupProtocolAndTreasury(svm);
  const ep = registerSimpleEndpoint(base, "jupiter", { exposureCap: 1_000_000n });
  const settler = generateKeypair(svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(svm, base.mint, saPda, 25_000_000n);
  fundPoolDirect(svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const now = Math.floor(Date.now() / 1000);
  const baseBalance = getTokenBalance(svm, agentAta);

  // Batch 1: 600k refund (under 1M cap).
  const ix1 = buildSettleBatch(settler.publicKey, saPda, [{
    callId: new Uint8Array(16).fill(10),
    agentOwner: agent.publicKey, agentAta,
    endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
    premium: 500n, refund: 600_000n, latencyMs: 6000, breach: true, timestamp: now - 3,
    feeRecipientAtas: [base.treasuryVault],
  }]);
  const t1 = new Transaction();
  t1.add(ix1);
  t1.recentBlockhash = svm.latestBlockhash();
  t1.feePayer = settler.publicKey;
  t1.sign(settler);
  expect(svm.sendTransaction(t1) instanceof FailedTransactionMetadata).toBe(false);

  const afterBatch1 = getTokenBalance(svm, agentAta);
  // -500 premium + 600_000 refund.
  expect(afterBatch1).toBe(baseBalance - 500n + 600_000n);

  // Batch 2: 500k refund. Cap remaining = 400k → refund zeroed.
  const ix2 = buildSettleBatch(settler.publicKey, saPda, [{
    callId: new Uint8Array(16).fill(11),
    agentOwner: agent.publicKey, agentAta,
    endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
    premium: 500n, refund: 500_000n, latencyMs: 6000, breach: true, timestamp: now - 2,
    feeRecipientAtas: [base.treasuryVault],
  }]);
  const t2 = new Transaction();
  t2.add(ix2);
  t2.recentBlockhash = svm.latestBlockhash();
  t2.feePayer = settler.publicKey;
  t2.sign(settler);
  expect(svm.sendTransaction(t2) instanceof FailedTransactionMetadata).toBe(false);

  // Agent received only the first batch's refund.
  // Net change vs original: -500 - 500 + 600_000 = 599_000.
  expect(getTokenBalance(svm, agentAta)).toBe(baseBalance - 1_000n + 600_000n);
});

test("exposure cap resets after 1 hour", () => {
  const svm = new LiteSVM();
  const base = setupProtocolAndTreasury(svm);
  const ep = registerSimpleEndpoint(base, "elfa", { exposureCap: 500_000n });
  const settler = generateKeypair(svm);
  const saPda = setupSettlementAuthority(base, settler);
  const { agent, agentAta } = provisionAgent(svm, base.mint, saPda, 25_000_000n);
  fundPoolDirect(svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const now = Math.floor(Date.now() / 1000);
  const baseBalance = getTokenBalance(svm, agentAta);

  // Use the full 500k cap.
  const ix1 = buildSettleBatch(settler.publicKey, saPda, [{
    callId: new Uint8Array(16).fill(20),
    agentOwner: agent.publicKey, agentAta,
    endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
    premium: 500n, refund: 500_000n, latencyMs: 6000, breach: true, timestamp: now - 2,
    feeRecipientAtas: [base.treasuryVault],
  }]);
  const t1 = new Transaction();
  t1.add(ix1);
  t1.recentBlockhash = svm.latestBlockhash();
  t1.feePayer = settler.publicKey;
  t1.sign(settler);
  expect(svm.sendTransaction(t1) instanceof FailedTransactionMetadata).toBe(false);

  // Advance clock by 2 hours.
  const clock = svm.getClock();
  svm.setClock(new Clock(
    clock.slot + 7200n,
    clock.epochStartTimestamp,
    clock.epoch,
    clock.leaderScheduleEpoch,
    clock.unixTimestamp + 7200n,
  ));

  // Second 500k refund — cap should have reset.
  const futureNow = now + 7200;
  const ix2 = buildSettleBatch(settler.publicKey, saPda, [{
    callId: new Uint8Array(16).fill(21),
    agentOwner: agent.publicKey, agentAta,
    endpointPda: ep.endpointPda, poolPda: ep.poolPda, poolVault: ep.poolVault, slug: ep.slug,
    premium: 500n, refund: 500_000n, latencyMs: 6000, breach: true, timestamp: futureNow - 1,
    feeRecipientAtas: [base.treasuryVault],
  }]);
  const t2 = new Transaction();
  t2.add(ix2);
  t2.recentBlockhash = svm.latestBlockhash();
  t2.feePayer = settler.publicKey;
  t2.sign(settler);
  expect(svm.sendTransaction(t2) instanceof FailedTransactionMetadata).toBe(false);

  // Both batches' refunds credited.
  expect(getTokenBalance(svm, agentAta)).toBe(baseBalance - 1_000n + 1_000_000n);
});
