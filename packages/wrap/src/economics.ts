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
//   outcome                                   | premium | refund          | covered
//   ------------------------------------------|---------|-----------------|--------
//   client_error                              | 0       | 0               | false
//   covered breach (latency_breach /          | flat    | principal+flat  | true
//     server_error / network_error)           |         |                 |
//   ok                                        | flat    | 0               | true
//
// Canonical refund on a covered breach (agent-tasks#11): return the agent's
// PRINCIPAL plus the premium they just paid — `principal + flatPremiumLamports`.
// Both paths share that formula; the optional `amountPaid` parameter only
// selects which value is the principal:
//
//   - amountPaid OMITTED (gateway / wrap): principal = `imputedCostLamports`,
//     the configured per-call parametric value. wrap has no notion of an
//     out-of-band payment, so a covered breach refunds
//     `imputedCostLamports + flatPremiumLamports`.
//   - amountPaid PRESENT (facilitator / pay.sh): principal = `amountPaid`, the
//     amount the agent paid the merchant. A covered breach refunds
//     `amountPaid + flatPremiumLamports`.
//
// premium charged is unchanged (`flatPremiumLamports`); only the refund moved
// from the old divergent models (gateway=imputed, facilitator=min(paid,imputed))
// to this `principal + premium` formula. See the parity test
// (packages/facilitator/test/economics-parity.test.ts).

import type { Outcome } from "./types";

export interface EconomicsPool {
  /** Flat premium per covered call, in lamports of the settlement mint. */
  flatPremiumLamports: bigint;
  /**
   * Configured per-call parametric value, in lamports. On the gateway/wrap path
   * this is the refund principal (refund = imputedCostLamports + flatPremium).
   */
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
 * @param amountPaid OPTIONAL. Selects the principal for the canonical
 *                   `principal + flatPremiumLamports` covered-breach refund.
 *                   When provided (facilitator / pay.sh path), principal =
 *                   `amountPaid` (what the agent paid the merchant). When
 *                   omitted (gateway / wrap path), principal =
 *                   `imputedCostLamports` (the configured per-call value).
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
    // Canonical refund (agent-tasks#11): principal + premium. The principal is
    // the agent's `amountPaid` on the facilitator path, or the configured
    // `imputedCostLamports` on the gateway/wrap path.
    const principal = amountPaid === undefined ? pool.imputedCostLamports : amountPaid;
    refund = principal + pool.flatPremiumLamports;
  }

  return {
    outcome,
    premiumLamports: pool.flatPremiumLamports,
    refundLamports: refund,
    covered: true,
  };
}
