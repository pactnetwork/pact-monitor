import { describe, test, expect } from "vitest";
import {
  computeCoverage,
  deriveCoverageId,
  isCoveredBreach,
  isKnownVerdict,
  poolSlugFor,
  verdictToOutcome,
} from "../src/lib/coverage.js";

const POOL = { flatPremiumLamports: 1_000n, imputedCostLamports: 10_000n };

describe("verdictToOutcome", () => {
  test("success / ok → ok", () => {
    expect(verdictToOutcome("success")).toBe("ok");
    expect(verdictToOutcome("ok")).toBe("ok");
  });
  test("breach verdicts pass through", () => {
    expect(verdictToOutcome("latency_breach")).toBe("latency_breach");
    expect(verdictToOutcome("server_error")).toBe("server_error");
    expect(verdictToOutcome("network_error")).toBe("network_error");
  });
  test("client_error / payment_failed → client_error", () => {
    expect(verdictToOutcome("client_error")).toBe("client_error");
    expect(verdictToOutcome("payment_failed")).toBe("client_error");
  });
});

describe("computeCoverage", () => {
  test("ok → premium=flat, refund=0, covered (no breach)", () => {
    expect(computeCoverage("ok", POOL, 50_000n)).toEqual({
      outcome: "ok",
      premiumLamports: 1_000n,
      refundLamports: 0n,
      covered: true,
    });
  });
  for (const o of ["latency_breach", "server_error", "network_error"] as const) {
    test(`${o}: refund = amount paid when < ceiling`, () => {
      expect(computeCoverage(o, POOL, 3_000n)).toEqual({
        outcome: o,
        premiumLamports: 1_000n,
        refundLamports: 3_000n,
        covered: true,
      });
      expect(isCoveredBreach(o)).toBe(true);
    });
    test(`${o}: refund capped at the pool's per-call ceiling`, () => {
      expect(computeCoverage(o, POOL, 999_999n)).toEqual({
        outcome: o,
        premiumLamports: 1_000n,
        refundLamports: 10_000n, // POOL.imputedCostLamports
        covered: true,
      });
    });
    test(`${o}: refund = 0 when amount paid is 0`, () => {
      expect(computeCoverage(o, POOL, 0n).refundLamports).toBe(0n);
    });
  }
  test("client_error → premium=0, refund=0, NOT covered", () => {
    expect(computeCoverage("client_error", POOL, 999_999n)).toEqual({
      outcome: "client_error",
      premiumLamports: 0n,
      refundLamports: 0n,
      covered: false,
    });
    expect(isCoveredBreach("client_error")).toBe(false);
  });
});

describe("isKnownVerdict", () => {
  test("accepts the known set", () => {
    for (const v of ["success", "ok", "latency_breach", "server_error", "network_error", "client_error", "payment_failed"]) {
      expect(isKnownVerdict(v)).toBe(true);
    }
  });
  test("rejects junk", () => {
    expect(isKnownVerdict("OK")).toBe(false);
    expect(isKnownVerdict("")).toBe(false);
    expect(isKnownVerdict("teapot")).toBe(false);
  });
});

describe("deriveCoverageId", () => {
  const a = { payee: "PayeePubkey1111111111111111111111111111111", resource: "https://x.example/r", paymentSignature: "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk" };
  test("is a UUIDv4-shaped string", () => {
    const id = deriveCoverageId(a);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test("is deterministic (idempotent re-register)", () => {
    expect(deriveCoverageId(a)).toBe(deriveCoverageId({ ...a }));
  });
  test("differs when any input changes", () => {
    const base = deriveCoverageId(a);
    expect(deriveCoverageId({ ...a, payee: "PayeePubkey2222222222222222222222222222222" })).not.toBe(base);
    expect(deriveCoverageId({ ...a, resource: "https://x.example/r2" })).not.toBe(base);
    expect(deriveCoverageId({ ...a, paymentSignature: "3q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk" })).not.toBe(base);
  });
});

describe("poolSlugFor", () => {
  test("MVP: always the default slug", () => {
    expect(poolSlugFor("a", "b", "pay-default")).toBe("pay-default");
  });
});
