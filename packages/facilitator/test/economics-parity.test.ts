// Money-path parity guardrail for the premium/refund dedup (agent-tasks#3, S2).
//
// Both the gateway path (`@pact-network/wrap` `computeEconomics`, called
// WITHOUT amountPaid) and the facilitator/pay.sh path (`computeCoverage`,
// called WITH the agent's claimed amountPaid) now share ONE math function.
// This test pins what that means for money:
//
//   - premium + covered are byte-identical on both paths for every outcome.
//   - non-breach refunds (ok, client_error) are identical (0).
//   - covered-breach refunds DIVERGE ON PURPOSE: the gateway pays the full
//     parametric `imputedCost`; the facilitator reimburses min(amountPaid,
//     imputedCost). They match only when amountPaid >= imputedCost.
//
// If any of these assertions break, money is settling differently than it did
// before the dedup — investigate before merging.

import { describe, test, expect } from "vitest";
import { computeEconomics } from "@pact-network/wrap";
import { computeCoverage } from "../src/lib/coverage.js";

const POOL = { flatPremiumLamports: 1_000n, imputedCostLamports: 10_000n };
const BREACHES = ["latency_breach", "server_error", "network_error"] as const;
const ALL = ["ok", "client_error", ...BREACHES] as const;
const AMOUNTS = [0n, 3_000n, 10_000n, 999_999n];

describe("economics parity: wrap (gateway) vs facilitator (pay.sh)", () => {
  describe("premium + covered are byte-identical everywhere", () => {
    for (const outcome of ALL) {
      for (const amountPaid of AMOUNTS) {
        test(`${outcome} @ amountPaid=${amountPaid}`, () => {
          const gateway = computeEconomics({ outcome, pool: POOL });
          const facilitator = computeCoverage(outcome, POOL, amountPaid);
          expect(facilitator.premiumLamports).toBe(gateway.premiumLamports);
          expect(facilitator.covered).toBe(gateway.covered);
          expect(facilitator.outcome).toBe(gateway.outcome);
        });
      }
    }
  });

  describe("covered-breach refund divergence boundary (proof no money moved)", () => {
    for (const outcome of BREACHES) {
      test(`${outcome}: amountPaid < imputed -> gateway pays imputed, facilitator pays amountPaid`, () => {
        const amountPaid = 3_000n; // < POOL.imputedCostLamports (10_000n)
        const gateway = computeEconomics({ outcome, pool: POOL }); // no amountPaid
        const facilitator = computeCoverage(outcome, POOL, amountPaid);
        expect(gateway.refundLamports).toBe(POOL.imputedCostLamports); // full parametric: 10_000n
        expect(facilitator.refundLamports).toBe(amountPaid); // reimburse-capped: 3_000n
        expect(gateway.refundLamports).not.toBe(facilitator.refundLamports); // differ ON PURPOSE
      });

      test(`${outcome}: amountPaid >= imputed -> both pay imputed (match)`, () => {
        const amountPaid = 999_999n; // >= imputed
        const gateway = computeEconomics({ outcome, pool: POOL });
        const facilitator = computeCoverage(outcome, POOL, amountPaid);
        expect(gateway.refundLamports).toBe(POOL.imputedCostLamports);
        expect(facilitator.refundLamports).toBe(POOL.imputedCostLamports);
        expect(gateway.refundLamports).toBe(facilitator.refundLamports);
      });
    }
  });

  describe("non-breach refunds match exactly", () => {
    test("ok -> both refund 0", () => {
      expect(computeEconomics({ outcome: "ok", pool: POOL }).refundLamports).toBe(0n);
      expect(computeCoverage("ok", POOL, 50_000n).refundLamports).toBe(0n);
    });

    test("client_error -> both 0 / 0 / uncovered", () => {
      const gateway = computeEconomics({ outcome: "client_error", pool: POOL });
      const facilitator = computeCoverage("client_error", POOL, 999_999n);
      expect(gateway).toMatchObject({ premiumLamports: 0n, refundLamports: 0n, covered: false });
      expect(facilitator).toMatchObject({ premiumLamports: 0n, refundLamports: 0n, covered: false });
    });
  });
});
