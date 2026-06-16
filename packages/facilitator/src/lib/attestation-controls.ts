// Abuse controls for the CLIENT-ATTESTED verdict path (agent-tasks#10).
//
// The off-gateway / x402 `register` path accepts the client's `verdict` on its
// word (verdictSource = "client_attested"). That is the moral-hazard hole: a
// caller can claim a breach that never happened and collect a refund. The
// on-chain hourly exposure cap (settle_batch) is the only hard bound today, and
// it is PER-ENDPOINT, not per-agent — sybils share one bucket and nothing
// throttles a single key (see SECURITY_REDTEAM_VERDICT.md attacks A-3/A-4).
//
// This module is the "accept-and-monitor" monitor: a PURE decision function
// (no I/O — all state is injected) that the facilitator route can consult
// BEFORE publishing a client-attested settlement event. It is gated behind
// `PACT_VERDICT_ATTESTATION_GATE` and defaults to OFF, so today's zero-friction
// behavior is unchanged until an operator opts in.
//
// It deliberately does NOT decide the verdict — the verdict is still the
// client's. It decides whether THIS client-attested refund is anomalous enough
// to decline (downgrade to uncovered) or merely log. The numbers/thresholds are
// owned by the red-team memo; the defaults here are conservative spike values.
//
// The gateway path (verdictSource = "pact_observed") never runs through this —
// Pact observed that outcome itself, so there is nothing to second-guess.

/**
 * Gate mode (3-value for shadow rollout):
 *   - "off":      do not evaluate. Publish as today. (DEFAULT — zero behaviour change.)
 *   - "log_only": evaluate and log a would-throttle, but PUBLISH anyway. Shadow mode:
 *                 collect signal before enforcing.
 *   - "enforce":  evaluate and DECLINE (downgrade to uncovered, do not publish) on throttle.
 */
export type AttestationGateMode = "off" | "log_only" | "enforce";

export function isAttestationGateMode(v: string): v is AttestationGateMode {
  return v === "off" || v === "log_only" || v === "enforce";
}

/** Per-agent / network state the decision needs. Injected — this module does no I/O. */
export interface AttestationStats {
  /**
   * Sum of refund base units already authorized for THIS agent's
   * client-attested covered breaches within the rolling window.
   */
  agentRefundLamportsInWindow: bigint;
  /** Count of THIS agent's covered (refunded) client-attested claims in the window. */
  agentCoveredClaimsInWindow: number;
  /** Count of THIS agent's TOTAL client-attested calls (covered + not) in the window. */
  agentTotalCallsInWindow: number;
  /**
   * Network-wide baseline covered-breach rate over a longer window, in [0,1].
   * The expected fraction of honest calls that breach. An agent far above this
   * is suspicious.
   *
   * SECURITY (agent-tasks#10 NIT #3): this MUST be computed from the TRUSTWORTHY
   * `verdictSource = 'pact_observed'` population (gateway self-observed calls),
   * NOT from client-attested rows. Drawing it from the same client-attested
   * pool the gate polices is self-poisoning: a sybil swarm's own forged breaches
   * raise the baseline and make the anomaly rule fire LESS. See
   * coverage.ts loadAttestationStats.
   */
  networkBreachClaimRate: number;
  /**
   * Number of trustworthy `pact_observed` calls the baseline above was computed
   * from. Used to fail OPEN on an empty baseline: until gateway traffic exists
   * there is no trustworthy population, so the BASELINE-RELATIVE anomaly term
   * (`networkBreachClaimRate * anomalyMultiple`) is dropped. The baseline-
   * INDEPENDENT absolute floor (`minBreachRateToFlag`) STILL applies — a
   * >50%-breach agent is blatant abuse regardless of the baseline. A genuine 0%
   * rate over a non-empty sample is distinct from "no samples yet": both leave
   * only the floor active here, but the distinction is explicit and intentional.
   */
  networkBaselineSamples: number;
}

export interface AttestationThresholds {
  /**
   * Max refund base units a single agent may accumulate from client-attested
   * covered breaches per rolling window. Above this → throttle. The on-chain cap
   * is per-ENDPOINT; this adds the per-AGENT dimension the chain lacks.
   */
  perAgentRefundCapLamportsPerWindow: bigint;
  /**
   * The agent's covered-breach rate must exceed BOTH an absolute floor AND
   * `networkBreachClaimRate * anomalyMultiple` before the rate rule fires. The
   * absolute floor avoids throttling low-volume agents on noise.
   */
  anomalyMultiple: number;
  /** Minimum covered-breach rate before the anomaly rule can fire at all, in [0,1]. */
  minBreachRateToFlag: number;
  /** Don't apply the rate rule until the agent has at least this many calls (small-sample guard). */
  minCallsForRateRule: number;
}

/**
 * Conservative spike defaults. The SECURITY_REDTEAM_VERDICT.md memo owns the
 * real production numbers; these exist so the module is usable and tested today.
 */
/**
 * How many full single refunds the per-agent rolling-window cap allows. The cap
 * bounds a VOLUME of claims, not one: a flat cap equal to a single max refund
 * (`imputedCost + flatPremium`) would throttle an honest agent's FIRST full-size
 * breach. 3 ≈ "a few genuine breaches per window"; the on-chain per-endpoint
 * hourly exposure cap remains the hard backstop above this.
 */
export const PER_AGENT_REFUND_CAP_CLAIMS = 3n;

/**
 * Pool-relative per-agent refund cap = `PER_AGENT_REFUND_CAP_CLAIMS` × the pool's
 * max single refund (`imputedCostLamports + flatPremiumLamports`). The register
 * route computes this from live pool config and passes it via `thresholds`, so
 * the cap tracks each pool's per-call ceiling instead of a one-size static
 * number — a single full-size breach is always under it, ~N+1 trips it.
 */
export function perAgentRefundCapFor(
  pool: { imputedCostLamports: bigint; flatPremiumLamports: bigint },
  claims: bigint = PER_AGENT_REFUND_CAP_CLAIMS,
): bigint {
  return claims * (pool.imputedCostLamports + pool.flatPremiumLamports);
}

export const DEFAULT_THRESHOLDS: AttestationThresholds = {
  // Static FALLBACK for direct callers/tests. Production overrides this
  // pool-relatively via `perAgentRefundCapFor(pool)` in the register route, so
  // the live cap is ~3 full refunds for the ACTUAL pool, not a flat number.
  // Default = 3 × (imputedCost 1_000_000 + premium 1_000) for the `pay-default`
  // pool = 3_003_000n: bounds a single key's VOLUME of claims without throttling
  // its first full-size breach (a flat 1_000_000n cap < the 1_001_000n max
  // single refund did exactly that). On-chain per-endpoint cap is the backstop.
  perAgentRefundCapLamportsPerWindow: 3_003_000n,
  anomalyMultiple: 3,
  minBreachRateToFlag: 0.5,
  minCallsForRateRule: 10,
};

export type AttestationDecision =
  | { decision: "allow" }
  | { decision: "throttle"; reason: AttestationThrottleReason };

export type AttestationThrottleReason =
  | "per_agent_refund_cap"
  | "breach_claim_rate_anomaly";

export interface AttestationInput {
  /** Refund base units THIS claim would authorize (0 means nothing to gate). */
  thisRefundLamports: bigint;
  stats: AttestationStats;
  thresholds?: AttestationThresholds;
}

/**
 * Decide whether a client-attested covered breach should be allowed or throttled.
 * PURE: deterministic in its inputs, no clock, no I/O. Returns `allow` for any
 * non-refunding claim (nothing to abuse) and for honest-looking traffic.
 */
export function evaluateClientAttestation(input: AttestationInput): AttestationDecision {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const { thisRefundLamports, stats } = input;

  // Nothing is being paid out → nothing to gate.
  if (thisRefundLamports <= 0n) return { decision: "allow" };

  // Rule 1 — per-agent rolling refund cap. Counts THIS claim toward the window.
  const projected = stats.agentRefundLamportsInWindow + thisRefundLamports;
  if (projected > t.perAgentRefundCapLamportsPerWindow) {
    return { decision: "throttle", reason: "per_agent_refund_cap" };
  }

  // Rule 2 — breach-claim-rate anomaly. Only fires above the small-sample guard
  // and above the ceiling, so honest low-volume agents are never throttled on
  // noise. This is the control sybils can't dodge for free: to look normal a
  // forger must emit mostly real (paid) non-breach calls.
  //
  // The ceiling has two terms:
  //   - the ABSOLUTE FLOOR (`minBreachRateToFlag`, e.g. 0.5) — baseline-
  //     INDEPENDENT. A >50%-breach agent over enough calls is blatant abuse
  //     regardless of what the network does.
  //   - the BASELINE-RELATIVE term (`networkBreachClaimRate * anomalyMultiple`)
  //     — needs a trustworthy `pact_observed` population to mean anything.
  //
  // Empty-baseline fail-open (agent-tasks#10 NIT #3): with no pact_observed
  // samples yet there is no trustworthy population, so the baseline-relative
  // term is dropped — we fail open on the MULTIPLE only. The absolute floor
  // SURVIVES: it does not depend on the baseline and must still catch blatant
  // abuse during the bootstrap window. (Rule 1 per-agent cap + the on-chain
  // hourly exposure cap remain bounds too.)
  if (stats.agentTotalCallsInWindow >= t.minCallsForRateRule) {
    const agentRate = stats.agentCoveredClaimsInWindow / stats.agentTotalCallsInWindow;
    const baselineCeiling =
      stats.networkBaselineSamples > 0
        ? Math.max(t.minBreachRateToFlag, stats.networkBreachClaimRate * t.anomalyMultiple)
        : t.minBreachRateToFlag;
    if (agentRate > baselineCeiling) {
      return { decision: "throttle", reason: "breach_claim_rate_anomaly" };
    }
  }

  return { decision: "allow" };
}
