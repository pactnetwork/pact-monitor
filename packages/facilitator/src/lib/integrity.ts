// PoC — verdict-integrity strategies for the pay.sh coverage register endpoint.
//
// Tracks agent-tasks#10: the facilitator pays pool-funded refunds off a
// CLIENT-SUPPLIED SLA verdict (`coverage.ts` -> verdictToOutcome -> refund),
// only enum-checking it (`isKnownVerdict`), never establishing that it's TRUE.
// A malicious agent can POST verdict:"server_error" for a call that actually
// succeeded and drain the pool.
//
// This module implements selectable integrity modes behind ONE flag
// (env COVERAGE_INTEGRITY_MODE). It changes NO behaviour at the default mode.
//
//   - "trust"            : current behaviour. Outcome = client verdict, refund
//                          flows whenever the outcome is a covered breach.
//                          Bounded only by the on-chain caps. (the bug)
//
//   - "verified-only"    : OPTION 2 (shippable core). Outcome still = client
//                          verdict, but a refund is eligible ONLY when the
//                          payment was on-chain-verified. Drops the
//                          unverified/degrade payout path. Does NOT fix the
//                          verdict-trust bug (a verified agent can still lie),
//                          but shrinks the blast radius to "agent who really
//                          paid, lying about a real call, capped at $1/call".
//
// A third "merchant-attested" mode (merchant-signed outcome receipt; the signed
// HTTP status overrides the client verdict) ships in the stacked follow-up PR.

import type { Outcome } from "@pact-network/wrap";
import { isCoveredBreach } from "./coverage.js";

export type IntegrityMode = "trust" | "verified-only";

export const INTEGRITY_MODES: readonly IntegrityMode[] = [
  "trust",
  "verified-only",
] as const;

export function isIntegrityMode(v: string): v is IntegrityMode {
  return (INTEGRITY_MODES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Unified refund-eligibility decision
// ---------------------------------------------------------------------------

export interface IntegrityDecision {
  /** The outcome to settle on. */
  outcome: Outcome;
  /** Whether a refund may flow for this outcome under the active mode. */
  refundEligible: boolean;
  /** Machine reason when a refund is withheld despite a covered outcome. */
  withheldReason: null | "unverified_payment";
}

/**
 * Decide the settlement outcome + refund eligibility for the active integrity
 * mode. Pure — all I/O (payment verify) is resolved by the caller and passed in.
 */
export function decideIntegrity(args: {
  mode: IntegrityMode;
  /** outcome from the CLIENT verdict (verdictToOutcome(body.verdict)). */
  clientOutcome: Outcome;
  /** did the on-chain payment verification pass? */
  verified: boolean;
}): IntegrityDecision {
  const { mode, clientOutcome, verified } = args;

  if (mode === "trust") {
    return { outcome: clientOutcome, refundEligible: true, withheldReason: null };
  }

  // verified-only
  // Drop the unverified/degrade payout path. Outcome unchanged.
  if (!isCoveredBreach(clientOutcome)) {
    return { outcome: clientOutcome, refundEligible: false, withheldReason: null };
  }
  return verified
    ? { outcome: clientOutcome, refundEligible: true, withheldReason: null }
    : { outcome: clientOutcome, refundEligible: false, withheldReason: "unverified_payment" };
}
