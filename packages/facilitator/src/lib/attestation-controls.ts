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
   * Network-wide baseline covered-breach rate across client-attested calls over
   * a longer window, in [0,1]. The expected fraction of honest calls that
   * breach. An agent far above this is suspicious.
   */
  networkBreachClaimRate: number;
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
export const DEFAULT_THRESHOLDS: AttestationThresholds = {
  // Per-agent window ceiling set well below the pool's whole-hour exposure cap
  // ($5 in env) so a single key cannot claim the entire hourly budget — the
  // per-agent rule must bite before the pool-wide cap does. Bounds a single key,
  // which the on-chain per-endpoint cap does not. Tighten further via config.
  perAgentRefundCapLamportsPerWindow: 1_000_000n,
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

  // Rule 2 — breach-claim-rate anomaly vs network baseline. Only fires with
  // enough samples and above the absolute floor, so honest low-volume agents are
  // never throttled on noise. This is the control sybils can't dodge for free:
  // to look normal a forger must emit mostly real (paid) non-breach calls.
  if (stats.agentTotalCallsInWindow >= t.minCallsForRateRule) {
    const agentRate = stats.agentCoveredClaimsInWindow / stats.agentTotalCallsInWindow;
    const baselineCeiling = Math.max(
      t.minBreachRateToFlag,
      stats.networkBreachClaimRate * t.anomalyMultiple,
    );
    if (agentRate > baselineCeiling) {
      return { decision: "throttle", reason: "breach_claim_rate_anomaly" };
    }
  }

  return { decision: "allow" };
}
