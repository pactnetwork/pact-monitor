// @pact-network/wrap — premium/refund economics.
//
// The single source of truth for how a classified `Outcome` maps to the
// premium charged and the refund owed. Both the gateway path (wrap's own
// `defaultClassifier`) and the x402 facilitator path
// (@pact-network/facilitator `coverage.ts`) compute money here so the two
// cannot drift.
//
// Premium and the breach/refund STRUCTURE are identical on both paths:
//
//   outcome                                   | premium | refund        | covered
//   ------------------------------------------|---------|---------------|--------
//   client_error                              | 0       | 0             | false
//   covered breach (latency_breach /          | flat    | see below     | true
//     server_error / network_error)           |         |               |
//   ok                                        | flat    | 0             | true
//
// The refund on a covered breach is the ONE place the two paths intentionally
// differ, and the optional `amountPaid` parameter is what encodes it:
//
//   - amountPaid OMITTED (gateway / wrap): refund = the full parametric
//     `imputedCostLamports`. wrap has no notion of an out-of-band payment; a
//     covered breach pays the fixed imputed cost.
//   - amountPaid PRESENT (facilitator / pay.sh): refund = min(amountPaid,
//     imputedCostLamports) — reimburse what the agent says it paid the
//     merchant, capped at the pool's per-call ceiling.
//
// Both are intentional and preserved exactly; see the parity test
// (packages/facilitator/test/economics-parity.test.ts).

import type { Outcome } from "./types";

export interface EconomicsPool {
  /** Flat premium per covered call, in lamports of the settlement mint. */
  flatPremiumLamports: bigint;
  /** Per-call refund ceiling on a covered breach, in lamports. */
  imputedCostLamports: bigint;
}

export interface Economics {
  outcome: Outcome;
  /** Lamports debited from the agent. 0 for `client_error` (uncovered). */
  premiumLamports: bigint;
  /** Lamports refunded to the agent. 0 unless the outcome is a covered breach. */
  refundLamports: bigint;
  /** True unless the outcome is the uncovered `client_error`. */
  covered: boolean;
}

/** True if the outcome is a covered SLA breach (refund flows). */
export function isCoveredBreach(outcome: Outcome): boolean {
  return (
    outcome === "latency_breach" ||
    outcome === "server_error" ||
    outcome === "network_error"
  );
}

/**
 * Compute the premium + refund for a classified outcome.
 *
 * @param outcome    canonical wrap `Outcome`.
 * @param pool       the coverage pool's flat-premium / imputed-cost config.
 * @param amountPaid OPTIONAL. When provided (facilitator / pay.sh path), a
 *                   covered-breach refund is `min(amountPaid, imputedCost)` —
 *                   reimburse-what-you-paid, capped. When omitted (gateway /
 *                   wrap path), a covered-breach refund is the full
 *                   `imputedCostLamports`.
 */
export function computeEconomics(args: {
  outcome: Outcome;
  pool: EconomicsPool;
  amountPaid?: bigint;
}): Economics {
  const { outcome, pool, amountPaid } = args;

  if (outcome === "client_error") {
    return { outcome, premiumLamports: 0n, refundLamports: 0n, covered: false };
  }

  let refund = 0n;
  if (isCoveredBreach(outcome)) {
    if (amountPaid === undefined) {
      refund = pool.imputedCostLamports;
    } else {
      refund =
        amountPaid < pool.imputedCostLamports ? amountPaid : pool.imputedCostLamports;
    }
  }

  return {
    outcome,
    premiumLamports: pool.flatPremiumLamports,
    refundLamports: refund,
    covered: true,
  };
}
