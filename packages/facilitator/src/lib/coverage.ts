// Coverage decision logic for pay.sh-covered calls.
//
// Maps the CLI's classifier `verdict` onto the canonical wrap `Outcome`,
// computes the premium + (possibly zero) refund the same way the gateway
// path's wrap classifier does, and derives the deterministic dedup id used as
// the Pub/Sub `callId` / facilitator `coverageId`.
//
// Premium/refund MATH is the single shared function `computeEconomics` in
// @pact-network/wrap (packages/wrap/src/economics.ts). `computeCoverage` below
// is a thin adapter over it — see docs/premium-coverage-mvp.md §A.2:
//
//   verdict           -> outcome          | premium    | refund
//   "success" / "ok"  -> "ok"             | flat       | 0
//   "latency_breach"  -> "latency_breach" | flat       | paid+flat*  (covered)
//   "server_error"    -> "server_error"   | flat       | paid+flat*  (covered)
//   "network_error"   -> "network_error"  | flat       | paid+flat*  (covered)
//   "payment_failed"  -> "client_error"   | 0          | 0           (uncovered)
//   "client_error" /  -> "client_error"   | 0          | 0           (uncovered)
//     anything 4xx-ish
//
// NOTE: this path shares the full premium AND refund math with wrap's
// `defaultClassifier` — both compute the canonical `principal + flatPremium`
// covered-breach refund (agent-tasks#11). The optional `amountPaid` parameter
// only selects the principal: *(`paid+flat` = amountPaid + flatPremium) on the
// facilitator path, vs (imputedCost + flatPremium) on the wrap/gateway path.
// The shared formula is asserted in
// packages/facilitator/test/economics-parity.test.ts.
//
// `client_error` (and the synonymous `payment_failed`) is the only non-`ok`
// outcome that is NOT covered: wrap sets premium=0, and the settler drops
// zero-premium events at its batcher boundary (a non-zero-premium client_error
// would abort the whole on-chain batch via PremiumTooSmall). The facilitator
// therefore returns `uncovered` for those and still records the receipt for
// analytics (no Pub/Sub event published — there's nothing to settle).

import { createHash, randomBytes } from "node:crypto";
import { computeEconomics } from "@pact-network/wrap";
import type { Outcome } from "@pact-network/wrap";

// The covered-breach predicate is shared with wrap — re-export it so existing
// `../src/lib/coverage` importers keep working without a second definition.
export { isCoveredBreach } from "@pact-network/wrap";

export type Verdict =
  | "success"
  | "ok"
  | "latency_breach"
  | "server_error"
  | "network_error"
  | "client_error"
  | "payment_failed";

/** The set of verdicts the register endpoint accepts. */
export const KNOWN_VERDICTS: readonly Verdict[] = [
  "success",
  "ok",
  "latency_breach",
  "server_error",
  "network_error",
  "client_error",
  "payment_failed",
] as const;

export function isKnownVerdict(v: string): v is Verdict {
  return (KNOWN_VERDICTS as readonly string[]).includes(v);
}

/** Normalise a CLI verdict to the canonical wrap `Outcome`. */
export function verdictToOutcome(v: Verdict): Outcome {
  switch (v) {
    case "success":
    case "ok":
      return "ok";
    case "latency_breach":
      return "latency_breach";
    case "server_error":
      return "server_error";
    case "network_error":
      return "network_error";
    case "client_error":
    case "payment_failed":
      return "client_error";
  }
}

export interface CoverageMath {
  outcome: Outcome;
  /** USDC base units. 0 for `client_error` (uncovered). */
  premiumLamports: bigint;
  /**
   * USDC base units. On a covered breach this is the canonical
   * `principal + flatPremium` refund (agent-tasks#11): the amount the agent paid
   * the merchant (`amountPaidBaseUnits`) plus the premium just charged. 0 unless
   * `isCoveredBreach(outcome)`. The on-chain `settle_batch` still clamps the
   * payout by the endpoint's hourly `exposure_cap_per_hour_lamports`.
   */
  refundLamports: bigint;
  /** True if a Pub/Sub settlement event should be published. */
  covered: boolean;
}

export interface PoolConfig {
  /** Flat premium per covered call, USDC base units. */
  flatPremiumLamports: bigint;
  /** Per-call refund ceiling on a covered breach, USDC base units. */
  imputedCostLamports: bigint;
}

/**
 * Compute the premium + refund for a pay.sh-covered call.
 *
 * @param outcome             canonical wrap outcome (from `verdictToOutcome`)
 * @param pool                the coverage pool's premium/imputed config
 * @param amountPaidBaseUnits the (on-chain-verified) amount the agent paid the
 *                            merchant; on a covered breach the refund is this
 *                            principal plus the flat premium just charged.
 */
export function computeCoverage(
  outcome: Outcome,
  pool: PoolConfig,
  amountPaidBaseUnits: bigint,
): CoverageMath {
  // Delegate the money math to wrap's single source of truth. Passing
  // `amountPaid` selects it as the principal: a covered-breach refund is the
  // canonical `amountPaid + flatPremium` (agent-tasks#11).
  return computeEconomics({
    outcome,
    pool,
    amountPaid: amountPaidBaseUnits,
  });
}

// ---------------------------------------------------------------------------
// Deterministic coverage / dedup id
// ---------------------------------------------------------------------------
//
// The on-chain `settle_batch` initialises a `CallRecord` PDA keyed by a 16-byte
// call id; re-submitting the same id poison-loops the batch. So the id MUST be
// deterministic from the payment — two register calls for the same payment must
// produce the same id (idempotent) but different payments must (overwhelmingly
// likely) differ. We take sha256(payee || resource || paymentSignature) and
// project the first 16 bytes into a UUIDv4-shaped string so it satisfies both
// the indexer's `Call.callId VARCHAR(36)` column and the market-proxy's
// CALL_ID_RE shape gate (version nibble = 4, variant nibble ∈ 8/9/a/b).

export function deriveCoverageId(args: {
  payee: string;
  resource: string;
  paymentSignature: string;
}): string {
  const h = createHash("sha256")
    .update(`pay.sh\n${args.payee}\n${args.resource}\n${args.paymentSignature}`, "utf8")
    .digest();
  const b = Uint8Array.from(h.subarray(0, 16));
  // Force the UUIDv4 version/variant nibbles.
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mint a fresh, random coverage id with the SAME UUIDv4 shape `deriveCoverageId`
 * produces (version nibble = 4, variant nibble ∈ 8/9/a/b) — but from
 * `crypto.randomBytes(16)` instead of a payment hash. Used when the register
 * call carries no `paymentSignature` (the "unverified" / degrade mode): there's
 * nothing to derive a deterministic dedup key from, so each call gets a new id.
 *
 * NOTE: unverified registrations are therefore NOT idempotent — re-running
 * `pact pay` is a different payment anyway, so a fresh id each time is correct.
 */
export function randomCoverageId(): string {
  const b = Uint8Array.from(randomBytes(16));
  // Force the UUIDv4 version/variant nibbles (same as deriveCoverageId).
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Map a `(payee, resource)` pair to a coverage-pool slug.
 *
 * MVP: always the single shared `pay-default` launch pool. The signature is
 * forward-compatible with the per-payee/per-resource pool model the design doc
 * sketches (B.2) — when that lands this becomes a config-table lookup with the
 * `pay-default` slug as the fallback.
 */
export function poolSlugFor(_payee: string, _resource: string, defaultSlug: string): string {
  return defaultSlug;
}
