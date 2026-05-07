import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupProtocolAndTreasury,
  registerSimpleEndpoint,
  buildPauseEndpoint,
  buildUpdateEndpointConfig,
  buildUpdateFeeRecipients,
  deriveEndpointConfig,
  slugBytes,
  generateKeypair,
} from "./helpers";

/**
 * Codex 2026-05-05 review fix: privilege-escalation mainnet blocker.
 *
 * Every privileged handler (pause_endpoint, update_endpoint_config,
 * register_endpoint, update_fee_recipients, initialize_treasury,
 * initialize_settlement_authority) now verifies that the supplied
 * ProtocolConfig account is the canonical [b"protocol_config"] PDA AND is
 * program-owned BEFORE reading the authority field. The same goes for
 * Treasury where applicable.
 *
 * These tests assert the hardening: a caller passing a fake ProtocolConfig
 * (right address but wrong owner, or wrong address entirely) is rejected
 * with a custom program error.
 */

const PROTOCOL_CONFIG_LEN = 464;

function makeFakeProtocolConfigBuffer(authority: PublicKey, mint: PublicKey): Uint8Array {
  // Mirrors `state.rs` ProtocolConfig layout. Critical fields:
  //   bump @ 0, _padding @ 1..7, authority @ 8..40, mint @ 40..72,
  //   max_total_fee_bps @ 72..74, default_fee_recipient_count @ 74,
  //   pad @ 75..80, fee_recipients @ 80..464.
  const buf = new Uint8Array(PROTOCOL_CONFIG_LEN);
  buf[0] = 255; // arbitrary bump
  buf.set(authority.toBytes(), 8);
  buf.set(mint.toBytes(), 40);
  new DataView(buf.buffer).setUint16(72, 3000, true);
  buf[74] = 0; // zero default recipients (handlers don't use defaults here)
  return buf;
}

test("pause_endpoint rejects fake ProtocolConfig at wrong address", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");

  // The attacker's "ProtocolConfig" lives at a random address with their
  // pubkey planted in the authority slot. The program should reject this
  // before ever reading the authority field.
  const attacker = generateKeypair(base.svm);
  const fakePc = Keypair.generate().publicKey;
  base.svm.setAccount(fakePc, {
    lamports: 10_000_000n,
    data: makeFakeProtocolConfigBuffer(attacker.publicKey, base.mint),
    owner: new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"), // program-owned
    executable: false,
  });

  const ix = buildPauseEndpoint({
    authority: attacker.publicKey,
    pcPda: fakePc,
    endpointPda: ep.endpointPda,
    paused: true,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = base.svm.sendTransaction(tx);
  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("pause_endpoint rejects ProtocolConfig at canonical address but wrong owner", () => {
  // Right address, wrong owner — caller forces a fake account at the
  // canonical PDA address but owned by a different program. owned_by check
  // must reject.
  //
  // We can only test this in isolation (without going through
  // setupProtocolAndTreasury) because the canonical PDA can't be claimed
  // twice in the same SVM. Build a minimal fake-PC fixture.
  const svm = new LiteSVM();
  const path = require("path");
  const { fileURLToPath } = require("url");
  // Inline loadProgram so we don't drag in setupProtocolAndTreasury here.
  const SO_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../target/deploy/pact_network_v1.so",
  );
  svm.addProgramFromFile(new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"), SO_PATH);

  const attacker = Keypair.generate();
  svm.setAccount(attacker.publicKey, {
    lamports: 10_000_000_000n,
    data: new Uint8Array(0),
    owner: SystemProgram.programId,
    executable: false,
  });

  const [pcPda] = require("./helpers").deriveProtocolConfig();
  // Plant a fake at the canonical PDA address but owned by an unrelated
  // program (TOKEN_PROGRAM_ID is a convenient stand-in for "not us").
  svm.setAccount(pcPda, {
    lamports: 10_000_000n,
    data: makeFakeProtocolConfigBuffer(attacker.publicKey, PublicKey.default),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  // Need an endpoint to target. Without a valid PC we can't go through the
  // normal register flow, so we plant a synthetic endpoint account at a
  // PDA address and verify pause_endpoint still rejects on the PC owner
  // check first (the endpoint reading would happen later).
  const slug = slugBytes("victim");
  const [endpointPda] = deriveEndpointConfig(slug);
  // Endpoint exists as a 544-byte program-owned account so the writability
  // check doesn't short-circuit before the PC check fires.
  svm.setAccount(endpointPda, {
    lamports: 10_000_000n,
    data: new Uint8Array(544),
    owner: new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"),
    executable: false,
  });

  const ix = buildPauseEndpoint({
    authority: attacker.publicKey,
    pcPda,
    endpointPda,
    paused: true,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = svm.sendTransaction(tx);
  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("update_endpoint_config rejects fake ProtocolConfig", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");

  const attacker = generateKeypair(base.svm);
  const fakePc = Keypair.generate().publicKey;
  base.svm.setAccount(fakePc, {
    lamports: 10_000_000n,
    data: makeFakeProtocolConfigBuffer(attacker.publicKey, base.mint),
    owner: new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"),
    executable: false,
  });

  const ix = buildUpdateEndpointConfig({
    authority: attacker.publicKey,
    pcPda: fakePc,
    endpointPda: ep.endpointPda,
    flatPremium: 9999n,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  const result = base.svm.sendTransaction(tx);
  expect(result instanceof FailedTransactionMetadata).toBe(true);
});

test("update_fee_recipients rejects fake Treasury", () => {
  const base = setupProtocolAndTreasury(new LiteSVM());
  const ep = registerSimpleEndpoint(base, "helius");

  // Real PC, fake Treasury. The handler must reject before reading
  // Treasury.usdc_vault.
  const fakeTreasury = Keypair.generate().publicKey;
  base.svm.setAccount(fakeTreasury, {
    lamports: 10_000_000n,
    data: new Uint8Array(80), // Treasury::LEN
    owner: new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"),
    executable: false,
  });

  const ix = buildUpdateFeeRecipients({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: fakeTreasury,
    endpointPda: ep.endpointPda,
    slug: ep.slug,
    recipients: [{ kind: 0, destination: PublicKey.default, bps: 1000 }],
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  expect(result instanceof FailedTransactionMetadata).toBe(true);
});
