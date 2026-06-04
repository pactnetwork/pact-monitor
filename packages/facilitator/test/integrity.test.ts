// Unit tests for the verdict-integrity strategies (agent-tasks#10).

import { describe, test, expect } from "vitest";
import { decideIntegrity, isIntegrityMode } from "../src/lib/integrity.js";

describe("isIntegrityMode", () => {
  test("accepts the two modes, rejects junk", () => {
    expect(isIntegrityMode("trust")).toBe(true);
    expect(isIntegrityMode("verified-only")).toBe(true);
    expect(isIntegrityMode("merchant-attested")).toBe(false);
    expect(isIntegrityMode("yolo")).toBe(false);
  });
});

describe("decideIntegrity", () => {
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
});
