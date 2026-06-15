import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
  deriveSettlementAuthority,
  deriveCallRecord,
  getAccountData,
  PROGRAM_ID,
} from "./helpers";

/**
 * SOL-01 (HIGH, mainnet-live) regression suite.
 *
 * Before the fix, `settle_batch` read accounts[1] (the SettlementAuthority)
 * with only a length check and then trusted `sa.signer`/`sa.bump`. An attacker
 * could craft a fake account with their own pubkey planted in the `signer`
 * slot and bypass the `UnauthorizedSettler` gate — enabling premium evasion,
 * batch-DoS via DuplicateCallId, and indexer poisoning.
 *
 * The fix adds `verify_settlement_authority(settlement_auth)?` — asserting the
 * account is the canonical [b"settlement_authority"] PDA AND owned by this
 * program — BEFORE its fields are trusted, mirroring the existing
 * `verify_protocol_config` guard. A forged account is rejected with
 * `InvalidSettlementAuthority` (custom 6033 = 0x1791).
 *
 * These tests use an otherwise-fully-valid batch (real ProtocolConfig, real
 * unpaused endpoint, funded pool, delegated agent) so the ONLY variable is the
 * SettlementAuthority account — proving the new gate is what fires.
 */

const SETTLEMENT_AUTHORITY_LEN = 48; // bump 1 + pad 7 + signer 32 + set_at 8
const SIGNER_OFFSET = 8;

function makeForgedSaBuffer(signer: PublicKey): Uint8Array {
  // Mirrors `state.rs` SettlementAuthority layout: bump @ 0, _padding0 @ 1..8,
  // signer @ 8..40, set_at @ 40..48. The attacker plants their own pubkey in
  // the `signer` slot so the pre-fix `sa.signer == settler_signer` check would
  // pass.
  const buf = new Uint8Array(SETTLEMENT_AUTHORITY_LEN);
  buf[0] = 255; // arbitrary bump
  buf.set(signer.toBytes(), SIGNER_OFFSET);
  return buf;
}

function logsHave6033(result: FailedTransactionMetadata): boolean {
  const logs = result.meta().logs().join("\n");
  return logs.includes("6033") || logs.includes("0x1791");
}

test("settle_batch rejects a FORGED settlement_authority at a wrong address (program-owned)", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const attacker = generateKeypair(base.svm);
  const { agent, agentAta } = (() => {
    const a = generateKeypair(base.svm);
    const ata = createTokenAccount(base.svm, base.mint, a.publicKey);
    mintTokensToAccount(base.svm, ata, 10_000_000n);
    // Agent has delegated to the attacker's forged authority address — the
    // worst case for the attacker, yet the gate still rejects before any of
    // this is consulted.
    return { agent: a, agentAta: ata };
  })();
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  // Forged SA lives at a random address, program-owned, with the attacker's
  // pubkey in the signer slot.
  const forgedSa = Keypair.generate().publicKey;
  base.svm.setAccount(forgedSa, {
    lamports: 10_000_000n,
    data: makeForgedSaBuffer(attacker.publicKey),
    owner: PROGRAM_ID, // program-owned, but NOT the canonical PDA address
    executable: false,
  });
  // Delegate the agent to the forged address so the only failing check is the
  // SettlementAuthority address validation.
  setTokenDelegate(base.svm, agentAta, forgedSa, 10_000_000n);

  const callId = new Uint8Array(16).fill(101);
  const now = Math.floor(Date.now() / 1000);
  const ix = buildSettleBatch(attacker.publicKey, forgedSa, [
    {
      callId,
      agentOwner: agent.publicKey,
      agentAta,
      endpointPda: ep.endpointPda,
      poolPda: ep.poolPda,
      poolVault: ep.poolVault,
      slug: ep.slug,
      premium: 1_000n,
      refund: 0n,
      latencyMs: 50,
      breach: false,
      timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = base.svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
  if (result instanceof FailedTransactionMetadata) {
    const ok = logsHave6033(result);
    if (!ok) console.log("FORGED-WRONG-ADDR logs:", result.meta().logs());
    expect(ok).toBe(true);
  }

  // No CallRecord created — the gate fires before any per-event work.
  const [crPda] = deriveCallRecord(callId);
  expect(getAccountData(base.svm, crPda)).toBeNull();
  // No premium debited.
  expect(getTokenBalance(base.svm, agentAta)).toBe(10_000_000n);
});

test("settle_batch rejects a settlement_authority at the canonical address but WRONG owner", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const attacker = generateKeypair(base.svm);
  const agent = generateKeypair(base.svm);
  const agentAta = createTokenAccount(base.svm, base.mint, agent.publicKey);
  mintTokensToAccount(base.svm, agentAta, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  // Plant a fake at the canonical SA PDA address but owned by an unrelated
  // program (TOKEN_PROGRAM_ID stands in for "not us"). owned_by(&ID) must
  // reject even though the address matches.
  const [saPda] = deriveSettlementAuthority();
  base.svm.setAccount(saPda, {
    lamports: 10_000_000n,
    data: makeForgedSaBuffer(attacker.publicKey),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
  setTokenDelegate(base.svm, agentAta, saPda, 10_000_000n);

  const callId = new Uint8Array(16).fill(102);
  const now = Math.floor(Date.now() / 1000);
  const ix = buildSettleBatch(attacker.publicKey, saPda, [
    {
      callId,
      agentOwner: agent.publicKey,
      agentAta,
      endpointPda: ep.endpointPda,
      poolPda: ep.poolPda,
      poolVault: ep.poolVault,
      slug: ep.slug,
      premium: 1_000n,
      refund: 0n,
      latencyMs: 50,
      breach: false,
      timestamp: now - 1,
      feeRecipientAtas: [base.treasuryVault],
    },
  ]);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = base.svm.sendTransaction(tx);

  expect(result instanceof FailedTransactionMetadata).toBe(true);
  if (result instanceof FailedTransactionMetadata) {
    const ok = logsHave6033(result);
    if (!ok) console.log("FORGED-WRONG-OWNER logs:", result.meta().logs());
    expect(ok).toBe(true);
  }

  const [crPda] = deriveCallRecord(callId);
  expect(getAccountData(base.svm, crPda)).toBeNull();
  expect(getTokenBalance(base.svm, agentAta)).toBe(10_000_000n);
});

test("settle_batch still ACCEPTS the real canonical settlement_authority PDA (happy path intact)", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");
  const settler = generateKeypair(base.svm);
  const saPda = setupSettlementAuthority(base, settler);

  const agent = generateKeypair(base.svm);
  const agentAta = createTokenAccount(base.svm, base.mint, agent.publicKey);
  mintTokensToAccount(base.svm, agentAta, 10_000_000n);
  setTokenDelegate(base.svm, agentAta, saPda, 10_000_000n);
  fundPoolDirect(base.svm, ep.poolPda, ep.poolVault, 5_000_000n);

  const callId = new Uint8Array(16).fill(103);
  const now = Math.floor(Date.now() / 1000);
  const premium = 10_000n;
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
  if (result instanceof FailedTransactionMetadata) {
    console.log("HAPPY-PATH ERR logs:", result.meta().logs());
  }
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Premium debited in full; CallRecord written.
  expect(getTokenBalance(base.svm, agentAta)).toBe(10_000_000n - premium);
  const [crPda] = deriveCallRecord(callId);
  expect(getAccountData(base.svm, crPda)).not.toBeNull();
});
