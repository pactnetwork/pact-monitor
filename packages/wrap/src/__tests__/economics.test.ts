// Direct unit test for the C-1 imputed-cost cap (agent-tasks#10), now enforced
// inside `computeEconomics` as the single source of truth. The facilitator's
// `computeCoverage` is a thin pass-through, so the clamp must hold here.

import { describe, it, expect } from "vitest";
import { computeEconomics } from "../economics";

const POOL = { flatPremiumLamports: 1_000n, imputedCostLamports: 10_000n };
const BREACHES = ["latency_breach", "server_error", "network_error"] as const;

describe("computeEconomics: C-1 imputed-cost cap (agent-tasks#10)", () => {
  for (const outcome of BREACHES) {
    it(`${outcome}: amountPaid > imputed is capped at imputed`, () => {
      // principal clamped to imputed (10_000n) + flat premium (1_000n) = 11_000n
      expect(
        computeEconomics({ outcome, pool: POOL, amountPaid: 999_999n }).refundLamports,
      ).toBe(POOL.imputedCostLamports + POOL.flatPremiumLamports);
    });

    it(`${outcome}: amountPaid < imputed is NOT capped (uses amountPaid)`, () => {
      // principal = amountPaid (3_000n) + flat premium (1_000n) = 4_000n
      expect(
        computeEconomics({ outcome, pool: POOL, amountPaid: 3_000n }).refundLamports,
      ).toBe(3_000n + POOL.flatPremiumLamports);
    });

    it(`${outcome}: amountPaid omitted (gateway path) = imputed + premium`, () => {
      // principal = imputed (10_000n); min(imputed, imputed) is behavior-neutral
      expect(
        computeEconomics({ outcome, pool: POOL }).refundLamports,
      ).toBe(POOL.imputedCostLamports + POOL.flatPremiumLamports);
    });

    it(`${outcome}: amountPaid == imputed is the cap boundary`, () => {
      expect(
        computeEconomics({ outcome, pool: POOL, amountPaid: POOL.imputedCostLamports }).refundLamports,
      ).toBe(POOL.imputedCostLamports + POOL.flatPremiumLamports);
    });
  }

  it("ok: no refund regardless of amountPaid (cap is irrelevant)", () => {
    expect(computeEconomics({ outcome: "ok", pool: POOL, amountPaid: 999_999n }).refundLamports).toBe(0n);
  });

  it("client_error: uncovered, no refund, no premium", () => {
    expect(computeEconomics({ outcome: "client_error", pool: POOL, amountPaid: 999_999n })).toEqual({
      outcome: "client_error",
      premiumLamports: 0n,
      refundLamports: 0n,
      covered: false,
    });
  });
});
