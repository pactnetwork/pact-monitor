// Money-path parity guardrail for the premium/refund dedup (agent-tasks#3, S2)
// + the canonical refund convergence (agent-tasks#11).
//
// Both the gateway path (`@pact-network/wrap` `computeEconomics`, called
// WITHOUT amountPaid) and the facilitator/pay.sh path (`computeCoverage`,
// called WITH the agent's claimed amountPaid) share ONE math function. This
// test pins what that means for money:
//
//   - premium + covered are byte-identical on both paths for every outcome.
//   - non-breach refunds (ok, client_error) are identical (0).
//   - covered-breach refunds follow ONE canonical formula on both paths:
//     `principal + flatPremium`. The only difference is the principal — the
//     gateway uses `imputedCost`, the facilitator uses `amountPaid` — so the two
//     refunds match exactly when amountPaid == imputedCost.
//
// If any of these assertions break, money is settling differently than the
// canonical `principal + premium` model — investigate before merging.

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

  describe("covered-breach refund = principal + premium on BOTH paths", () => {
    for (const outcome of BREACHES) {
      test(`${outcome}: gateway pays imputed + premium`, () => {
        const gateway = computeEconomics({ outcome, pool: POOL }); // no amountPaid
        // principal = imputedCost (10_000n) + flatPremium (1_000n) = 11_000n
        expect(gateway.refundLamports).toBe(
          POOL.imputedCostLamports + POOL.flatPremiumLamports,
        );
      });

      test(`${outcome}: facilitator pays amountPaid + premium`, () => {
        const amountPaid = 3_000n;
        const facilitator = computeCoverage(outcome, POOL, amountPaid);
        // principal = amountPaid (3_000n) + flatPremium (1_000n) = 4_000n
        expect(facilitator.refundLamports).toBe(amountPaid + POOL.flatPremiumLamports);
      });

      test(`${outcome}: paths match exactly when amountPaid == imputed`, () => {
        const amountPaid = POOL.imputedCostLamports; // 10_000n
        const gateway = computeEconomics({ outcome, pool: POOL });
        const facilitator = computeCoverage(outcome, POOL, amountPaid);
        expect(facilitator.refundLamports).toBe(gateway.refundLamports);
        expect(gateway.refundLamports).toBe(
          POOL.imputedCostLamports + POOL.flatPremiumLamports,
        );
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
