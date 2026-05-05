import { describe, expect, test } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  CALL_RECORD_LEN,
  COVERAGE_POOL_LEN,
  ENDPOINT_CONFIG_LEN,
  FEE_RECIPIENT_LEN,
  FeeRecipientKind,
  PROTOCOL_CONFIG_LEN,
  SETTLEMENT_AUTHORITY_LEN,
  SettlementStatus,
  TREASURY_LEN,
  decodeCallRecord,
  decodeCoveragePool,
  decodeEndpointConfig,
  decodeFeeRecipient,
  decodeFeeRecipientArray,
  decodeProtocolConfig,
  decodeSettlementAuthority,
  decodeTreasury,
} from "../src/state.js";

function writePubkey(buf: Uint8Array, offset: number, pk: PublicKey): void {
  buf.set(pk.toBytes(), offset);
}

function encodeFeeRecipient(
  buf: Uint8Array,
  off: number,
  kind: number,
  dest: PublicKey,
  bps: number
): void {
  buf[off] = kind;
  // _pad0 zero
  writePubkey(buf, off + 8, dest);
  new DataView(buf.buffer, buf.byteOffset).setUint16(off + 40, bps, true);
}

describe("state decoders — round-trip on hand-rolled byte buffers", () => {
  test("FeeRecipient round-trip", () => {
    const buf = new Uint8Array(FEE_RECIPIENT_LEN);
    const dest = Keypair.generate().publicKey;
    encodeFeeRecipient(buf, 0, FeeRecipientKind.AffiliateAta, dest, 1234);
    const r = decodeFeeRecipient(buf);
    expect(r.kind).toBe(FeeRecipientKind.AffiliateAta);
    expect(r.bps).toBe(1234);
    expect(r.destination).toBe(dest.toBase58());
  });

  test("decodeFeeRecipient rejects unknown kind byte", () => {
    const buf = new Uint8Array(FEE_RECIPIENT_LEN);
    buf[0] = 7;
    expect(() => decodeFeeRecipient(buf)).toThrow(/unknown kind/);
  });

  test("decodeFeeRecipientArray honours count", () => {
    const buf = new Uint8Array(FEE_RECIPIENT_LEN * 3);
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const c = Keypair.generate().publicKey;
    encodeFeeRecipient(buf, 0, 0, a, 100);
    encodeFeeRecipient(buf, FEE_RECIPIENT_LEN, 1, b, 200);
    encodeFeeRecipient(buf, 2 * FEE_RECIPIENT_LEN, 2, c, 300);
    const out = decodeFeeRecipientArray(buf, 0, 2);
    expect(out).toHaveLength(2);
    expect(out[0].destination).toBe(a.toBase58());
    expect(out[1].destination).toBe(b.toBase58());
  });

  test("decodeCoveragePool round-trip on a canonical buffer", () => {
    const buf = new Uint8Array(COVERAGE_POOL_LEN);
    const view = new DataView(buf.buffer);
    const authority = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const slug = new TextEncoder().encode("openai");

    buf[0] = 254;
    writePubkey(buf, 8, authority);
    writePubkey(buf, 40, mint);
    writePubkey(buf, 72, vault);
    buf.set(slug, 104);
    view.setBigUint64(120, 100n, true); // total_deposits
    view.setBigUint64(128, 200n, true); // total_premiums
    view.setBigUint64(136, 50n, true);  // total_refunds
    view.setBigUint64(144, 250n, true); // current_balance
    view.setBigInt64(152, 1714000000n, true);

    const cp = decodeCoveragePool(buf);
    expect(cp.bump).toBe(254);
    expect(cp.authority).toBe(authority.toBase58());
    expect(cp.usdcMint).toBe(mint.toBase58());
    expect(cp.usdcVault).toBe(vault.toBase58());
    expect(cp.totalDeposits).toBe(100n);
    expect(cp.totalPremiums).toBe(200n);
    expect(cp.totalRefunds).toBe(50n);
    expect(cp.currentBalance).toBe(250n);
    expect(cp.createdAt).toBe(1714000000n);
    expect(cp.endpointSlug.length).toBe(16);
    expect(Array.from(cp.endpointSlug.slice(0, 6))).toEqual(
      Array.from(slug)
    );
  });

  test("decodeEndpointConfig round-trip with one fee_recipient", () => {
    const buf = new Uint8Array(ENDPOINT_CONFIG_LEN);
    const view = new DataView(buf.buffer);
    const slug = new TextEncoder().encode("test-ep");
    const coveragePool = Keypair.generate().publicKey;
    const dest = Keypair.generate().publicKey;

    buf[0] = 253; // bump
    buf[1] = 1; // paused
    buf.set(slug, 8);
    view.setBigUint64(24, 500n, true); // flat_premium
    view.setUint16(32, 250, true); // percent_bps
    view.setUint32(40, 5000, true); // sla_latency_ms
    view.setBigUint64(48, 1000n, true); // imputed_cost
    view.setBigUint64(56, 5_000_000n, true); // exposure_cap
    view.setBigInt64(64, 1714000000n, true); // current_period_start
    view.setBigUint64(72, 0n, true); // current_period_refunds
    view.setBigUint64(80, 7n, true); // total_calls
    view.setBigUint64(88, 1n, true); // total_breaches
    view.setBigUint64(96, 3500n, true); // total_premiums
    view.setBigUint64(104, 100n, true); // total_refunds
    view.setBigInt64(112, 1714000100n, true); // last_updated
    writePubkey(buf, 120, coveragePool);
    buf[152] = 1; // fee_recipient_count
    encodeFeeRecipient(buf, 160, FeeRecipientKind.Treasury, dest, 1000);

    const ep = decodeEndpointConfig(buf);
    expect(ep.bump).toBe(253);
    expect(ep.paused).toBe(true);
    expect(ep.flatPremiumLamports).toBe(500n);
    expect(ep.percentBps).toBe(250);
    expect(ep.slaLatencyMs).toBe(5000);
    expect(ep.imputedCostLamports).toBe(1000n);
    expect(ep.exposureCapPerHourLamports).toBe(5_000_000n);
    expect(ep.totalCalls).toBe(7n);
    expect(ep.totalBreaches).toBe(1n);
    expect(ep.totalPremiums).toBe(3500n);
    expect(ep.totalRefunds).toBe(100n);
    expect(ep.lastUpdated).toBe(1714000100n);
    expect(ep.coveragePool).toBe(coveragePool.toBase58());
    expect(ep.feeRecipientCount).toBe(1);
    expect(ep.feeRecipients).toHaveLength(1);
    expect(ep.feeRecipients[0].kind).toBe(FeeRecipientKind.Treasury);
    expect(ep.feeRecipients[0].bps).toBe(1000);
    expect(ep.feeRecipients[0].destination).toBe(dest.toBase58());
  });

  test("CALL_RECORD_LEN is 112 bytes (codex 2026-05-05)", () => {
    expect(CALL_RECORD_LEN).toBe(112);
  });

  test("decodeCallRecord round-trip on the 112-byte layout", () => {
    const buf = new Uint8Array(CALL_RECORD_LEN);
    const view = new DataView(buf.buffer);
    const callId = new Uint8Array(16).fill(0x42);
    const agent = Keypair.generate().publicKey;
    const slug = new TextEncoder().encode("openai");

    buf[0] = 252;
    buf[1] = 1; // breach
    buf[2] = SettlementStatus.Settled;
    buf.set(callId, 8);
    writePubkey(buf, 24, agent);
    buf.set(slug, 56);
    view.setBigUint64(72, 5000n, true);  // premium_lamports
    view.setBigUint64(80, 1000n, true);  // refund_lamports
    view.setBigUint64(88, 1000n, true);  // actual_refund_lamports
    view.setUint32(96, 3500, true);       // latency_ms (offset shifted +8)
    view.setBigInt64(104, 1714000000n, true); // timestamp (offset shifted +8)

    const cr = decodeCallRecord(buf);
    expect(cr.bump).toBe(252);
    expect(cr.breach).toBe(true);
    expect(cr.settlementStatus).toBe(SettlementStatus.Settled);
    expect(Array.from(cr.callId)).toEqual(Array.from(callId));
    expect(cr.agent).toBe(agent.toBase58());
    expect(Array.from(cr.endpointSlug.slice(0, 6))).toEqual(Array.from(slug));
    expect(cr.premiumLamports).toBe(5000n);
    expect(cr.refundLamports).toBe(1000n);
    expect(cr.actualRefundLamports).toBe(1000n);
    expect(cr.latencyMs).toBe(3500);
    expect(cr.timestamp).toBe(1714000000n);
  });

  test.each([
    SettlementStatus.Settled,
    SettlementStatus.DelegateFailed,
    SettlementStatus.PoolDepleted,
    SettlementStatus.ExposureCapClamped,
  ])("decodeCallRecord round-trips SettlementStatus = %i", (status) => {
    const buf = new Uint8Array(CALL_RECORD_LEN);
    const view = new DataView(buf.buffer);
    buf[0] = 1;
    buf[1] = 0;
    buf[2] = status;
    view.setBigUint64(72, 1n, true);
    view.setBigUint64(80, 0n, true);
    view.setBigUint64(88, 0n, true);
    view.setUint32(96, 0, true);
    view.setBigInt64(104, 0n, true);

    const cr = decodeCallRecord(buf);
    expect(cr.settlementStatus).toBe(status);
  });

  test("decodeCallRecord rejects an unknown settlement_status byte", () => {
    const buf = new Uint8Array(CALL_RECORD_LEN);
    buf[2] = 7; // unknown
    expect(() => decodeCallRecord(buf)).toThrow(
      /unknown settlement_status/
    );
  });

  test("decodeCallRecord surfaces actualRefundLamports independently of refundLamports (PoolDepleted)", () => {
    const buf = new Uint8Array(CALL_RECORD_LEN);
    const view = new DataView(buf.buffer);
    buf[0] = 5;
    buf[1] = 1; // breach
    buf[2] = SettlementStatus.PoolDepleted;
    view.setBigUint64(72, 10_000n, true); // premium
    view.setBigUint64(80, 9_999n, true);  // intended refund (was supposed to be paid)
    view.setBigUint64(88, 0n, true);      // actual refund — pool depleted
    view.setUint32(96, 250, true);
    view.setBigInt64(104, 1714000000n, true);

    const cr = decodeCallRecord(buf);
    expect(cr.settlementStatus).toBe(SettlementStatus.PoolDepleted);
    expect(cr.refundLamports).toBe(9_999n);
    expect(cr.actualRefundLamports).toBe(0n);
  });

  test("decodeCallRecord rejects pre-codex 104-byte buffers", () => {
    // 104 < 112 — old layout buffers must not silently decode.
    expect(() => decodeCallRecord(new Uint8Array(104))).toThrow();
  });

  test("decodeSettlementAuthority round-trip", () => {
    const buf = new Uint8Array(SETTLEMENT_AUTHORITY_LEN);
    const view = new DataView(buf.buffer);
    const signer = Keypair.generate().publicKey;
    buf[0] = 251;
    writePubkey(buf, 8, signer);
    view.setBigInt64(40, 1714000000n, true);

    const sa = decodeSettlementAuthority(buf);
    expect(sa.bump).toBe(251);
    expect(sa.signer).toBe(signer.toBase58());
    expect(sa.setAt).toBe(1714000000n);
  });

  test("decodeTreasury round-trip", () => {
    const buf = new Uint8Array(TREASURY_LEN);
    const view = new DataView(buf.buffer);
    const auth = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    buf[0] = 250;
    writePubkey(buf, 8, auth);
    writePubkey(buf, 40, vault);
    view.setBigInt64(72, 1714000000n, true);

    const t = decodeTreasury(buf);
    expect(t.bump).toBe(250);
    expect(t.authority).toBe(auth.toBase58());
    expect(t.usdcVault).toBe(vault.toBase58());
    expect(t.setAt).toBe(1714000000n);
  });

  test("decodeProtocolConfig round-trip with two recipients", () => {
    const buf = new Uint8Array(PROTOCOL_CONFIG_LEN);
    const view = new DataView(buf.buffer);
    const auth = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const treasury = Keypair.generate().publicKey;
    const aff = Keypair.generate().publicKey;

    buf[0] = 249;
    writePubkey(buf, 8, auth);
    writePubkey(buf, 40, mint);
    view.setUint16(72, 3000, true); // max_total_fee_bps
    buf[74] = 2; // count
    encodeFeeRecipient(buf, 80, FeeRecipientKind.Treasury, treasury, 1000);
    encodeFeeRecipient(buf, 80 + FEE_RECIPIENT_LEN, FeeRecipientKind.AffiliateAta, aff, 500);

    const pc = decodeProtocolConfig(buf);
    expect(pc.bump).toBe(249);
    expect(pc.authority).toBe(auth.toBase58());
    expect(pc.usdcMint).toBe(mint.toBase58());
    expect(pc.maxTotalFeeBps).toBe(3000);
    expect(pc.defaultFeeRecipientCount).toBe(2);
    expect(pc.defaultFeeRecipients).toHaveLength(2);
    expect(pc.defaultFeeRecipients[0].kind).toBe(FeeRecipientKind.Treasury);
    expect(pc.defaultFeeRecipients[0].destination).toBe(treasury.toBase58());
    expect(pc.defaultFeeRecipients[0].bps).toBe(1000);
    expect(pc.defaultFeeRecipients[1].kind).toBe(FeeRecipientKind.AffiliateAta);
    expect(pc.defaultFeeRecipients[1].destination).toBe(aff.toBase58());
    expect(pc.defaultFeeRecipients[1].bps).toBe(500);
  });

  test("decoders reject buffers that are too short", () => {
    expect(() => decodeCoveragePool(new Uint8Array(10))).toThrow();
    expect(() => decodeEndpointConfig(new Uint8Array(10))).toThrow();
    expect(() => decodeCallRecord(new Uint8Array(10))).toThrow();
    expect(() => decodeSettlementAuthority(new Uint8Array(10))).toThrow();
    expect(() => decodeTreasury(new Uint8Array(10))).toThrow();
    expect(() => decodeProtocolConfig(new Uint8Array(10))).toThrow();
  });
});
