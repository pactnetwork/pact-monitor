// PoC — verdict-integrity strategies for the pay.sh coverage register endpoint.
//
// Tracks agent-tasks#10: the facilitator pays pool-funded refunds off a
// CLIENT-SUPPLIED SLA verdict (`coverage.ts` -> verdictToOutcome -> refund),
// only enum-checking it (`isKnownVerdict`), never establishing that it's TRUE.
// A malicious agent can POST verdict:"server_error" for a call that actually
// succeeded and drain the pool.
//
// This module implements three selectable integrity modes so the two design
// options in the issue can be compared side-by-side behind ONE flag
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
//   - "merchant-attested": OPTION 1 (viable form). A refund is eligible only
//                          when the request carries a MERCHANT-SIGNED outcome
//                          receipt and the payment is verified. The covered
//                          outcome is derived from the merchant's SIGNED HTTP
//                          status, NOT the client verdict — so the client can
//                          no longer forge the breach. Honest limitation: this
//                          can only cover breaches the merchant can sign for
//                          (latency_breach, soft 5xx). It STRUCTURALLY cannot
//                          cover network_error (merchant unreachable => no one
//                          to sign), which is why it can't be the only control.
//
// PoC scope / not-production caveats:
//   - The merchant receipt is signed by the `payee` wallet pubkey itself. A
//     production design needs a merchant-registry that separates the receiving
//     wallet from an online signing key (a wallet is not necessarily an online
//     signer). Flagged, not solved here.
//   - No staleness window on the receipt beyond `issuedAt` parsing (the same
//     open TODO payment-verify.ts already carries for paymentSignature).

import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { Outcome } from "@pact-network/wrap";
import { isCoveredBreach } from "./coverage.js";

export type IntegrityMode = "trust" | "verified-only" | "merchant-attested";

export const INTEGRITY_MODES: readonly IntegrityMode[] = [
  "trust",
  "verified-only",
  "merchant-attested",
] as const;

export function isIntegrityMode(v: string): v is IntegrityMode {
  return (INTEGRITY_MODES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Option 1 — merchant-signed outcome receipt
// ---------------------------------------------------------------------------

/**
 * A merchant's signed attestation of the HTTP outcome it returned for a paid
 * call. Optional field on the register body. The merchant signs the canonical
 * payload (below) with the ed25519 key of `payee`.
 */
export interface MerchantOutcomeReceipt {
  /** Must equal the register body's `resource`. */
  resource: string;
  /** Upstream HTTP status the merchant asserts it returned for this call. */
  status: number;
  /** Must equal the register body's `agent` — binds the receipt to one agent. */
  agent: string;
  /** Must equal the register body's `paymentSignature` — binds to THIS paid call. */
  paymentSignature: string;
  /** ISO-8601 issue time (freshness). */
  issuedAt: string;
  /** bs58 ed25519 signature over `buildMerchantReceiptPayload`, by `payee`. */
  merchantSig: string;
}

/**
 * Canonical bytes the merchant signs. Deterministic, newline-delimited — same
 * style as the agent envelope's `buildSignaturePayload`. MUST be reproduced
 * byte-for-byte by the merchant signer.
 */
export function buildMerchantReceiptPayload(r: {
  resource: string;
  status: number;
  agent: string;
  paymentSignature: string;
  issuedAt: string;
}): string {
  return `pact-merchant-receipt/v1\n${r.resource}\n${r.status}\n${r.agent}\n${r.paymentSignature}\n${r.issuedAt}`;
}

/** Map a merchant-signed HTTP status to the canonical wrap outcome. */
export function statusToOutcome(status: number): Outcome {
  if (status >= 200 && status < 400) return "ok";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500) return "server_error";
  // 1xx or out-of-range — treat as uncovered client_error (matches the gateway's
  // conservative handling of non-2xx-non-5xx).
  return "client_error";
}

export type ReceiptVerifyResult =
  | { ok: true; outcome: Outcome }
  | { ok: false; reason: ReceiptVerifyError };

export type ReceiptVerifyError =
  | "missing"
  | "malformed"
  | "resource_mismatch"
  | "agent_mismatch"
  | "payment_mismatch"
  | "bad_signature";

/**
 * Verify a merchant outcome receipt against the register body. The receipt must
 * bind to the same agent, resource and payment, and carry a valid ed25519
 * signature by `payee`. Returns the merchant-attested outcome on success.
 */
export function verifyMerchantReceipt(args: {
  receipt: MerchantOutcomeReceipt | undefined;
  payee: string | null;
  agent: string;
  resource: string;
  paymentSignature: string | undefined;
}): ReceiptVerifyResult {
  const { receipt, payee, agent, resource, paymentSignature } = args;
  if (!receipt) return { ok: false, reason: "missing" };
  if (
    typeof receipt.resource !== "string" ||
    typeof receipt.status !== "number" ||
    !Number.isFinite(receipt.status) ||
    typeof receipt.agent !== "string" ||
    typeof receipt.paymentSignature !== "string" ||
    typeof receipt.issuedAt !== "string" ||
    typeof receipt.merchantSig !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  // Attestation is only meaningful against an on-chain-confirmed merchant key.
  if (!payee || !paymentSignature) return { ok: false, reason: "malformed" };
  if (receipt.resource !== resource) return { ok: false, reason: "resource_mismatch" };
  if (receipt.agent !== agent) return { ok: false, reason: "agent_mismatch" };
  if (receipt.paymentSignature !== paymentSignature) {
    return { ok: false, reason: "payment_mismatch" };
  }

  const payload = buildMerchantReceiptPayload({
    resource: receipt.resource,
    status: receipt.status,
    agent: receipt.agent,
    paymentSignature: receipt.paymentSignature,
    issuedAt: receipt.issuedAt,
  });
  let merchantKey: Uint8Array;
  let sig: Uint8Array;
  try {
    merchantKey = bs58.decode(payee);
    sig = bs58.decode(receipt.merchantSig);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (merchantKey.length !== 32 || sig.length !== 64) {
    return { ok: false, reason: "bad_signature" };
  }
  let verified = false;
  try {
    verified = nacl.sign.detached.verify(
      new TextEncoder().encode(payload),
      sig,
      merchantKey,
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "bad_signature" };
  return { ok: true, outcome: statusToOutcome(receipt.status) };
}

// ---------------------------------------------------------------------------
// Unified refund-eligibility decision
// ---------------------------------------------------------------------------

export interface IntegrityDecision {
  /** The outcome to settle on. May differ from the client verdict in
   *  merchant-attested mode (the signed status wins). */
  outcome: Outcome;
  /** Whether a refund may flow for this outcome under the active mode. */
  refundEligible: boolean;
  /** Machine reason when a refund is withheld despite a covered outcome. */
  withheldReason:
    | null
    | "unverified_payment"
    | "no_merchant_receipt"
    | "verdict_receipt_mismatch";
}

/**
 * Decide the settlement outcome + refund eligibility for the active integrity
 * mode. Pure — all I/O (payment verify, receipt presence) is resolved by the
 * caller and passed in.
 */
export function decideIntegrity(args: {
  mode: IntegrityMode;
  /** outcome from the CLIENT verdict (verdictToOutcome(body.verdict)). */
  clientOutcome: Outcome;
  /** did the on-chain payment verification pass? */
  verified: boolean;
  /** merchant-receipt verification result (only consulted in merchant-attested). */
  receipt?: ReceiptVerifyResult;
}): IntegrityDecision {
  const { mode, clientOutcome, verified, receipt } = args;

  if (mode === "trust") {
    return { outcome: clientOutcome, refundEligible: true, withheldReason: null };
  }

  if (mode === "verified-only") {
    // Drop the unverified/degrade payout path. Outcome unchanged.
    if (!isCoveredBreach(clientOutcome)) {
      return { outcome: clientOutcome, refundEligible: false, withheldReason: null };
    }
    return verified
      ? { outcome: clientOutcome, refundEligible: true, withheldReason: null }
      : { outcome: clientOutcome, refundEligible: false, withheldReason: "unverified_payment" };
  }

  // merchant-attested
  if (!verified) {
    return { outcome: clientOutcome, refundEligible: false, withheldReason: "unverified_payment" };
  }
  if (!receipt || !receipt.ok) {
    // No trustworthy merchant attestation -> the breach signal is unproven.
    // This is the branch that STRUCTURALLY drops network_error (merchant down
    // => can never produce a receipt). Refund withheld; outcome reported as the
    // client's claim for analytics, but settles as uncovered (see route).
    return { outcome: clientOutcome, refundEligible: false, withheldReason: "no_merchant_receipt" };
  }
  // The merchant's signed status is authoritative for the outcome.
  const attested = receipt.outcome;
  if (!isCoveredBreach(attested)) {
    return { outcome: attested, refundEligible: false, withheldReason: null };
  }
  return { outcome: attested, refundEligible: true, withheldReason: null };
}

/** sha256 hex — exported for tests/parity with the envelope hashing. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
