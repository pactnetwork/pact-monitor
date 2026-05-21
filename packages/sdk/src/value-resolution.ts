/**
 * C4 — Resolve the declared per-call value used for observation/record
 * shape. Premium math is endpoint-fixed on V1, so the resolved value is
 * informational on covered calls; it still matters for bare-path
 * observations and for the future V2 policy lookup.
 *
 * Precedence (spec §3 "Resolving the call value"):
 *   1. x402 PAYMENT-REQUIRED challenge amount (verified — the agent paid it)
 *   2. MPP / x402 PAYMENT-RESPONSE / Payment-Receipt (verified, same trust)
 *   3. Explicit per-call `insure`
 *   4. createPact `insureDefault`
 *   5. None — informational observation only
 *
 * Steps 1–2 read from the response. Step 1 is a 402 response body
 * (x402 challenge); step 2 is a successful response header.
 *
 * The amounts here are in WHOLE USD (e.g. 0.05 = 5 cents). Lamport / USDC
 * base-unit conversion happens at the observation builder, not here.
 *
 * The receipt parser is intentionally inlined (rather than imported from
 * @q3labs/pact-monitor) because pact-monitor doesn't export
 * extractPaymentData and the SDK should not pull in monitor as a dependency
 * for a 20-line decoder.
 */

export type ValueSource =
  | "x402_challenge"
  | "payment_response"
  | "per_call_insure"
  | "insure_default"
  | "none";

export interface ResolvedValue {
  source: ValueSource;
  amountUsd: number | null;
}

interface X402Challenge {
  amount?: string;
  /** Some PAYMENT-REQUIRED bodies use `maxAmountRequired` instead. */
  maxAmountRequired?: string;
  asset?: string;
}

interface X402ChallengeBody {
  accepts?: X402Challenge[];
}

/**
 * Parse a 402 PAYMENT-REQUIRED challenge body — used when the upstream
 * returns 402 ahead of negotiation. Returns null on any structural issue.
 * The body's `accepts[].amount` (or `maxAmountRequired`) is a string in the
 * declared asset's base units; if the asset is anything other than USDC
 * (6-decimal USD-pegged) we return null because the SDK can't convert it.
 */
/**
 * Decode a base64 PAYMENT-RESPONSE / Payment-Receipt header and return the
 * amount in WHOLE USD if present. Honors both header names + lowercase and
 * the two amount fields x402 / MPP receipts use in practice
 * (`amount`, `value`, `usdc`, or `amountUsd`).
 */
export function decodeReceiptAmountUsd(headers: Headers): number | null {
  const raw =
    headers.get("PAYMENT-RESPONSE") ??
    headers.get("payment-response") ??
    headers.get("Payment-Receipt") ??
    headers.get("payment-receipt");
  if (!raw) return null;
  try {
    const decoded = JSON.parse(atob(raw)) as {
      amount?: number | string;
      amountUsd?: number | string;
      value?: number | string;
      usdc?: number | string;
    };
    const candidates = [
      decoded.amountUsd,
      decoded.amount,
      decoded.value,
      decoded.usdc,
    ];
    for (const c of candidates) {
      if (c == null) continue;
      const n = typeof c === "string" ? Number(c) : c;
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseX402ChallengeBody(body: string): number | null {
  let parsed: X402ChallengeBody;
  try {
    parsed = JSON.parse(body) as X402ChallengeBody;
  } catch {
    return null;
  }
  if (!parsed?.accepts?.length) return null;
  for (const accept of parsed.accepts) {
    const raw = accept.amount ?? accept.maxAmountRequired;
    if (!raw) continue;
    const baseUnits = Number(raw);
    if (!Number.isFinite(baseUnits) || baseUnits < 0) continue;
    // We assume USDC (6 decimals). x402 spec allows other assets but a
    // best-effort conversion without an asset table would risk a wildly
    // inflated insure value, so we bail.
    return baseUnits / 1_000_000;
  }
  return null;
}

export interface ResolveValueArgs {
  responseStatus: number;
  responseHeaders: Headers;
  /** Raw 402 body, if the upstream returned 402 and the caller can supply it. */
  challengeBody?: string | null;
  perCallInsureUsd?: number | null;
  insureDefaultUsd?: number | null;
}

export function resolveCallValue(args: ResolveValueArgs): ResolvedValue {
  // 1. x402 PAYMENT-REQUIRED challenge (402 body).
  if (args.responseStatus === 402 && args.challengeBody) {
    const amt = parseX402ChallengeBody(args.challengeBody);
    if (amt != null && amt > 0) {
      return { source: "x402_challenge", amountUsd: amt };
    }
  }

  // 2. Successful payment receipt — decode the PAYMENT-RESPONSE /
  // Payment-Receipt header and take its amount if present.
  const receiptAmount = decodeReceiptAmountUsd(args.responseHeaders);
  if (receiptAmount != null && receiptAmount > 0) {
    return { source: "payment_response", amountUsd: receiptAmount };
  }

  // 3. Explicit per-call override.
  if (
    typeof args.perCallInsureUsd === "number" &&
    args.perCallInsureUsd > 0 &&
    Number.isFinite(args.perCallInsureUsd)
  ) {
    return { source: "per_call_insure", amountUsd: args.perCallInsureUsd };
  }

  // 4. createPact-level default.
  if (
    typeof args.insureDefaultUsd === "number" &&
    args.insureDefaultUsd > 0 &&
    Number.isFinite(args.insureDefaultUsd)
  ) {
    return { source: "insure_default", amountUsd: args.insureDefaultUsd };
  }

  return { source: "none", amountUsd: null };
}
