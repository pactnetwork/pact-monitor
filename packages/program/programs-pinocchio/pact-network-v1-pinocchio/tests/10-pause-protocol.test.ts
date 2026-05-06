import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupProtocolAndTreasury,
  buildPauseProtocol,
  deriveProtocolConfig,
  generateKeypair,
  getAccountData,
  PROGRAM_ID,
} from "./helpers";

/**
 * Mainnet kill-switch: `pause_protocol` flips ProtocolConfig.paused (byte 75).
 * While paused, `settle_batch` returns PactError::ProtocolPaused before any
 * per-event work — see 05-settle-batch.test.ts for that side. These tests
 * cover the pause_protocol instruction itself.
 *
 * Layout reminder (state.rs `ProtocolConfig`):
 *   bump@0, _padding0@1..7, authority@8..40, usdc_mint@40..72,
 *   max_total_fee_bps@72..74, default_fee_recipient_count@74,
 *   paused@75, _padding1@76..80, default_fee_recipients@80..464.
 */

const PAUSED_OFFSET = 75;

test("pause_protocol(1) sets paused = 1; pause_protocol(0) clears it", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());

  // Sanity: post-init paused = 0.
  const initial = getAccountData(base.svm, base.pcPda)!;
  expect(initial[PAUSED_OFFSET]).toBe(0);

  // Pause.
  const pauseIx = buildPauseProtocol({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    paused: 1,
  });
  const t1 = new Transaction();
  t1.add(pauseIx);
  t1.recentBlockhash = base.svm.latestBlockhash();
  t1.feePayer = base.authority.publicKey;
  t1.sign(base.authority);
  const r1 = base.svm.sendTransaction(t1);
  if (r1 instanceof FailedTransactionMetadata) {
    console.log("PAUSE ERR logs:", r1.meta().logs());
  }
  expect(r1 instanceof FailedTransactionMetadata).toBe(false);

  const paused = getAccountData(base.svm, base.pcPda)!;
  expect(paused[PAUSED_OFFSET]).toBe(1);

  // Unpause.
  const unpauseIx = buildPauseProtocol({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    paused: 0,
  });
  const t2 = new Transaction();
  t2.add(unpauseIx);
  t2.recentBlockhash = base.svm.latestBlockhash();
  t2.feePayer = base.authority.publicKey;
  t2.sign(base.authority);
  expect(base.svm.sendTransaction(t2) instanceof FailedTransactionMetadata).toBe(false);

  const unpaused = getAccountData(base.svm, base.pcPda)!;
  expect(unpaused[PAUSED_OFFSET]).toBe(0);
});

test("pause_protocol rejects non-authority signer", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());

  const attacker = generateKeypair(base.svm);
  const ix = buildPauseProtocol({
    authority: attacker.publicKey,
    pcPda: base.pcPda,
    paused: 1,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = base.svm.sendTransaction(tx);
  expect(result instanceof FailedTransactionMetadata).toBe(true);

  // Paused flag MUST still be 0.
  const data = getAccountData(base.svm, base.pcPda)!;
  expect(data[PAUSED_OFFSET]).toBe(0);
});

test("pause_protocol rejects fake ProtocolConfig at wrong address", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());

  // Plant a counterfeit ProtocolConfig owned by the program but at a wrong
  // address with the attacker's pubkey in the authority slot.
  const attacker = generateKeypair(base.svm);
  const fakePc = Keypair.generate().publicKey;
  const fakeBuf = new Uint8Array(464);
  fakeBuf[0] = 255; // arbitrary bump
  fakeBuf.set(attacker.publicKey.toBytes(), 8); // authority @ 8..40
  base.svm.setAccount(fakePc, {
    lamports: 10_000_000n,
    data: fakeBuf,
    owner: PROGRAM_ID,
    executable: false,
  });

  const ix = buildPauseProtocol({
    authority: attacker.publicKey,
    pcPda: fakePc,
    paused: 1,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  expect(base.svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);

  // Real ProtocolConfig MUST still be unpaused.
  const real = getAccountData(base.svm, base.pcPda)!;
  expect(real[PAUSED_OFFSET]).toBe(0);
});

test("pause_protocol rejects ProtocolConfig at canonical address but wrong owner", () => {
  // Same vuln class as 09-auth-pda.test.ts — caller plants a fake at the
  // canonical PDA address but owned by a different program. owned_by check
  // must reject before the authority field is even read.
  const svm = new LiteSVM();
  const path = require("path");
  const { fileURLToPath } = require("url");
  const SO_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../target/deploy/pact_network_v1.so",
  );
  svm.addProgramFromFile(PROGRAM_ID, SO_PATH);

  const attacker = Keypair.generate();
  svm.setAccount(attacker.publicKey, {
    lamports: 10_000_000_000n,
    data: new Uint8Array(0),
    owner: SystemProgram.programId,
    executable: false,
  });

  const [pcPda] = deriveProtocolConfig();
  const fakeBuf = new Uint8Array(464);
  fakeBuf[0] = 255;
  fakeBuf.set(attacker.publicKey.toBytes(), 8);
  svm.setAccount(pcPda, {
    lamports: 10_000_000n,
    data: fakeBuf,
    owner: TOKEN_PROGRAM_ID, // wrong owner
    executable: false,
  });

  const ix = buildPauseProtocol({
    authority: attacker.publicKey,
    pcPda,
    paused: 1,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  expect(svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
