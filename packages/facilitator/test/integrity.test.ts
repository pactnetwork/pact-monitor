// Unit tests for the verdict-integrity strategies (agent-tasks#10).

import { describe, test, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  buildMerchantReceiptPayload,
  decideIntegrity,
  isIntegrityMode,
  statusToOutcome,
  verifyMerchantReceipt,
  type MerchantOutcomeReceipt,
} from "../src/lib/integrity.js";

const merchantKp = nacl.sign.keyPair();
const PAYEE = bs58.encode(merchantKp.publicKey);
const AGENT = bs58.encode(nacl.sign.keyPair().publicKey);
const RESOURCE = "https://merchant.example/api/quote";
const PAY_SIG = "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk";

const ISSUED = "2026-06-04T00:00:00.000Z";
const NOW_MS = Date.parse(ISSUED) + 1_000; // 1s after issue — inside the window

function makeReceipt(over: Partial<MerchantOutcomeReceipt> = {}, signWith = merchantKp.secretKey): MerchantOutcomeReceipt {
  const base = {
    resource: RESOURCE,
    status: 503,
    agent: AGENT,
    paymentSignature: PAY_SIG,
    issuedAt: ISSUED,
  };
  const fields = { ...base, ...over };
  const payload = buildMerchantReceiptPayload(fields);
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), signWith);
  return { ...fields, merchantSig: over.merchantSig ?? bs58.encode(sig) };
}

describe("isIntegrityMode", () => {
  test("accepts the three modes, rejects junk", () => {
    expect(isIntegrityMode("trust")).toBe(true);
    expect(isIntegrityMode("verified-only")).toBe(true);
    expect(isIntegrityMode("merchant-attested")).toBe(true);
    expect(isIntegrityMode("yolo")).toBe(false);
  });
});

describe("statusToOutcome", () => {
  test("2xx/3xx → ok", () => {
    expect(statusToOutcome(200)).toBe("ok");
    expect(statusToOutcome(204)).toBe("ok");
    expect(statusToOutcome(301)).toBe("ok");
  });
  test("4xx → client_error", () => {
    expect(statusToOutcome(400)).toBe("client_error");
    expect(statusToOutcome(404)).toBe("client_error");
  });
  test("5xx → server_error", () => {
    expect(statusToOutcome(500)).toBe("server_error");
    expect(statusToOutcome(503)).toBe("server_error");
  });
});

describe("verifyMerchantReceipt", () => {
  const ok = { payee: PAYEE, agent: AGENT, resource: RESOURCE, paymentSignature: PAY_SIG, nowMs: NOW_MS };

  test("valid receipt → ok, outcome from signed status", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ status: 503 }), ...ok });
    expect(r).toEqual({ ok: true, outcome: "server_error" });
  });
  test("valid 200 receipt → ok, outcome=ok (forgery defence)", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ status: 200 }), ...ok });
    expect(r).toEqual({ ok: true, outcome: "ok" });
  });
  test("valid 4xx receipt → ok, outcome=client_error (uncovered downstream)", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ status: 404 }), ...ok });
    expect(r).toEqual({ ok: true, outcome: "client_error" });
  });
  test("missing receipt → missing", () => {
    expect(verifyMerchantReceipt({ receipt: undefined, ...ok })).toEqual({ ok: false, reason: "missing" });
  });
  test("malformed receipt (bad field types) → malformed", () => {
    const bad = { ...makeReceipt(), status: "503" as unknown as number };
    expect(verifyMerchantReceipt({ receipt: bad, ...ok })).toEqual({ ok: false, reason: "malformed" });
  });
  test("no payee/paymentSignature (unverified) → malformed", () => {
    expect(verifyMerchantReceipt({ receipt: makeReceipt(), payee: null, agent: AGENT, resource: RESOURCE, paymentSignature: undefined, nowMs: NOW_MS }))
      .toEqual({ ok: false, reason: "malformed" });
  });
  test("stale receipt (issuedAt outside the freshness window) → stale", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt(), ...ok, nowMs: Date.parse(ISSUED) + 10 * 60_000 });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });
  test("unparseable issuedAt → stale", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ issuedAt: "not-a-date" }), ...ok });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });
  test("resource mismatch → resource_mismatch", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ resource: "https://evil.example" }), ...ok });
    expect(r).toEqual({ ok: false, reason: "resource_mismatch" });
  });
  test("agent mismatch → agent_mismatch", () => {
    const other = bs58.encode(nacl.sign.keyPair().publicKey);
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ agent: other }), ...ok });
    expect(r).toEqual({ ok: false, reason: "agent_mismatch" });
  });
  test("payment mismatch → payment_mismatch", () => {
    const r = verifyMerchantReceipt({ receipt: makeReceipt({ paymentSignature: "3q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk" }), ...ok });
    expect(r).toEqual({ ok: false, reason: "payment_mismatch" });
  });
  test("signature by wrong key → bad_signature", () => {
    const imposter = nacl.sign.keyPair();
    const r = verifyMerchantReceipt({ receipt: makeReceipt({}, imposter.secretKey), ...ok });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });
  test("tampered status (signed 200, claims 503) → bad_signature", () => {
    const signed = makeReceipt({ status: 200 });
    const tampered = { ...signed, status: 503 }; // sig no longer matches payload
    const r = verifyMerchantReceipt({ receipt: tampered, ...ok });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("decideIntegrity", () => {
  const verifiedReceipt = { ok: true as const, outcome: "server_error" as const };

  test('trust: refund eligible regardless of verified', () => {
    expect(decideIntegrity({ mode: "trust", clientOutcome: "server_error", verified: false }))
      .toEqual({ outcome: "server_error", refundEligible: true, withheldReason: null });
  });

  test('verified-only: covered breach + verified → eligible', () => {
    expect(decideIntegrity({ mode: "verified-only", clientOutcome: "server_error", verified: true }))
      .toEqual({ outcome: "server_error", refundEligible: true, withheldReason: null });
  });
  test('verified-only: covered breach + UNVERIFIED → withheld', () => {
    expect(decideIntegrity({ mode: "verified-only", clientOutcome: "server_error", verified: false }))
      .toEqual({ outcome: "server_error", refundEligible: false, withheldReason: "unverified_payment" });
  });
  test('verified-only: non-breach (ok) → not eligible, no withhold reason', () => {
    expect(decideIntegrity({ mode: "verified-only", clientOutcome: "ok", verified: true }))
      .toEqual({ outcome: "ok", refundEligible: false, withheldReason: null });
  });

  test('merchant-attested: unverified → withheld (unverified_payment)', () => {
    expect(decideIntegrity({ mode: "merchant-attested", clientOutcome: "server_error", verified: false, receipt: verifiedReceipt }))
      .toEqual({ outcome: "server_error", refundEligible: false, withheldReason: "unverified_payment" });
  });
  test('merchant-attested: verified, no receipt → withheld (no_merchant_receipt)', () => {
    expect(decideIntegrity({ mode: "merchant-attested", clientOutcome: "server_error", verified: true, receipt: { ok: false, reason: "missing" } }))
      .toEqual({ outcome: "server_error", refundEligible: false, withheldReason: "no_merchant_receipt" });
  });
  test('merchant-attested: verified + valid breach receipt → eligible, attested outcome wins', () => {
    expect(decideIntegrity({ mode: "merchant-attested", clientOutcome: "network_error", verified: true, receipt: verifiedReceipt }))
      .toEqual({ outcome: "server_error", refundEligible: true, withheldReason: null });
  });
  test('merchant-attested: verified + receipt says ok (forged breach) → not eligible', () => {
    expect(decideIntegrity({ mode: "merchant-attested", clientOutcome: "server_error", verified: true, receipt: { ok: true, outcome: "ok" } }))
      .toEqual({ outcome: "ok", refundEligible: false, withheldReason: null });
  });
});
