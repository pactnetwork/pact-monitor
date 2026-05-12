// Builds the coverage-registration payload `pact pay` posts to
// facilitator.pact.network from the post-pay classifier output.
//
// Context — the side-call model (see docs/premium-coverage-mvp.md §B.1):
// `pay` has already settled the payment directly with the merchant; this
// payload is a *receipt* the facilitator records, prices, and (on a
// covered failure) refunds against the subsidised `pay-default` pool via
// the same on-chain `settle_batch` machinery the gateway path uses.
//
// What we CAN extract from pay 0.13.0/0.16.0's verbose output (see
// pay-classifier.ts): the resource URL, the 402 scheme (x402 / mpp), the
// amount + asset (base units + mint on the MPP path and on the x402
// auto-pay "Building x402 payment" line), the payee/merchant address
// (x402 auto-pay path only — `recipient=`), the signer (the agent's own
// pubkey), and the upstream HTTP outcome.
//
// What we CANNOT extract — pay 0.16.0 does not log them in any captured
// fixture:
//   - `payee` (MPP path / legacy x402 body line only): the merchant
//     address. On the MPP path and the legacy "402 Payment Required"
//     x402 body line, pay consumes the challenge internally and never
//     prints the recipient — we omit it there. On the x402 auto-pay
//     path (`pay curl '<url>?x402=1'`) pay DOES log it as `recipient=`
//     on the "Building x402 payment" line, and we populate `payee` from
//     it. When absent, the facilitator re-derives the payee from its
//     own knowledge of the resource or prices conservatively / rejects.
//   - `paymentSignature`: the on-chain settle tx sig. pay 0.16.0 prints
//     `signer=…` but not the tx sig. We include it only if a (future)
//     pay build adds it to its trace (classifier scans `tx=`/`signature=`
//     best-effort). Omitted otherwise.
//
// Where a field can't be reliably extracted we omit it from the JSON
// body entirely (vs sending null) so the facilitator's schema validation
// can distinguish "not provided" from "provided as null".

import type { ClassifyResult, Outcome, PaymentScheme } from "./pay-classifier.ts";

// Maps the classifier outcome onto the facilitator's `verdict` field.
// The facilitator owns the coverage decision; this is only the
// *classification* of what happened to the call.
//
//   success        → "success"        (no refund)
//   server_error   → "server_error"   (covered failure → refund)
//   client_error   → "client_error"   (caller fault → no refund under default SLA)
//   payment_failed → "payment_failed" (payment leg never settled → nothing to cover)
//   tool_error     → "tool_error"     (wrapped tool failed before any 402)
//
// "latency_breach" is in the verdict vocabulary but the classifier
// cannot detect it from pay 0.16.0's output (no latency field). If a
// future pay build logs latency and the resource's SLA is known, the
// facilitator can re-derive the breach itself; we never send
// "latency_breach" today.
export type Verdict =
  | "success"
  | "server_error"
  | "client_error"
  | "payment_failed"
  | "tool_error"
  | "latency_breach";

export function outcomeToVerdict(outcome: Outcome): Verdict {
  switch (outcome) {
    case "success":
      return "success";
    case "server_error":
      return "server_error";
    case "client_error":
      return "client_error";
    case "payment_failed":
      return "payment_failed";
    case "tool_error":
      return "tool_error";
  }
}

// The coverage-registration request body. Fields that couldn't be
// extracted are absent on the wire (not present with a null value) — see
// `buildCoveragePayload` which constructs the object conditionally.
export interface CoverageRegistrationPayload {
  // Agent's Solana pubkey, base58. Always present (it's our own key).
  agent: string;
  // Merchant address from the 402 challenge, base58. Often absent — pay
  // doesn't log it (see file header).
  payee?: string;
  // The resource (URL) that was paid for. Best-effort from pay's
  // `resource="…"` trace; absent if pay didn't log it.
  resource?: string;
  // Which 402 protocol pay used.
  scheme: PaymentScheme;
  // On-chain settle tx signature, base58. Almost always absent (see
  // file header).
  paymentSignature?: string;
  // Payment amount in the asset's smallest unit, as a decimal string.
  // Absent when pay didn't log a numeric amount we can trust the scale
  // of.
  amountBaseUnits?: string;
  // The asset's SPL mint, base58. Absent when pay only gave a symbol.
  asset?: string;
  // Classification of what happened to the call.
  verdict: Verdict;
  // Upstream HTTP status, when known.
  upstreamStatus?: number;
  // Call latency in ms, when pay reported it. Absent otherwise.
  latencyMs?: number;
}

export interface BuildCoveragePayloadInput {
  agentPubkey: string;            // base58
  classified: ClassifyResult;
}

export function buildCoveragePayload(
  input: BuildCoveragePayloadInput,
): CoverageRegistrationPayload {
  const { classified } = input;
  const p = classified.payment;

  const payload: CoverageRegistrationPayload = {
    agent: input.agentPubkey,
    scheme: p.scheme ?? "unknown",
    verdict: outcomeToVerdict(classified.outcome),
  };

  // payee — the merchant address from the x402 challenge. pay
  // 0.13.0/0.16.0 DOES log it on the x402 auto-pay path as `recipient=`
  // on the "Building x402 payment" credential-build line; the classifier
  // surfaces it as `payment.payeePubkey`. The legacy x402 body line and
  // the MPP path don't carry it — absent there.
  if (p.payeePubkey) payload.payee = p.payeePubkey;

  if (p.resource) payload.resource = p.resource;
  if (p.txSignature) payload.paymentSignature = p.txSignature;
  if (p.amountBaseUnits) payload.amountBaseUnits = p.amountBaseUnits;
  // Prefer the SPL mint; fall back to the symbol only if that's all we
  // have (the facilitator can map "USDC" → the canonical mint, but a
  // mint is unambiguous so send it when we have it).
  if (p.assetMint) payload.asset = p.assetMint;
  else if (p.asset) payload.asset = p.asset;
  if (classified.upstreamStatus !== null && classified.upstreamStatus !== undefined) {
    payload.upstreamStatus = classified.upstreamStatus;
  }
  if (typeof p.latencyMs === "number") payload.latencyMs = p.latencyMs;

  return payload;
}

// True when this classifier result represents a call we should register
// coverage for: a payment was actually attempted (`payment.attempted`).
// A free passthrough (no 402 challenge) has nothing to cover.
export function shouldRegisterCoverage(classified: ClassifyResult): boolean {
  return classified.payment.attempted === true;
}

// Lists the fields that COULD NOT be extracted from pay's output for
// this receipt, for a soft diagnostic line. Empty when everything was
// available.
export function missingReceiptFields(
  payload: CoverageRegistrationPayload,
): string[] {
  const missing: string[] = [];
  if (!payload.payee) missing.push("payee");
  if (!payload.paymentSignature) missing.push("paymentSignature");
  if (!payload.resource) missing.push("resource");
  if (!payload.amountBaseUnits) missing.push("amountBaseUnits");
  if (!payload.asset) missing.push("asset");
  return missing;
}
