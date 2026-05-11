// Post-pay classifier. After `pay <args>` exits, this inspects the
// captured streams + exit code and decides whether Pact would refund
// the call under its standard SLA policy.
//
// Signals we look for (matched against solana-foundation/pay's verbose
// output, verified vs source rust/crates/cli/src/commands/mod.rs
// 2026-05-05):
//
//   "402 Payment Required (x402) — N USDC"   ← unconditional on the
//                                              auto-pay path; tells us a
//                                              payment was attempted and
//                                              extracts the amount.
//   "Payment signed, retrying..."             ← verbose-only; confirms
//                                              the payment succeeded.
//   "Payment failed:" / similar               ← payment never settled;
//                                              outcome is payment_failed.
//
// Upstream HTTP status: when the wrapped tool is curl, pay forwards
// curl's exit code as its own. curl returns 0 on a 2xx, 22 on a 4xx/5xx
// (only if -f was supplied), and various non-zero codes for network
// errors. Without -f, curl exits 0 even on a 5xx and writes the body to
// stdout — so we ALSO scan the captured stdout for an HTTP status
// hint (e.g. `-w "%{http_code}"` or a JSON-RPC error envelope) when
// possible.

// pay.sh's verbose line: "402 Payment Required (x402) — N USDC". The
// parenthetical "(x402)" contains the digits "402" which would steal
// the amount capture if we used a non-digit run. Anchor on the em-dash
// pay.sh emits (verified vs source 2026-05-05) and pull the
// "<amount> <asset>" pair from after it.
const PAYMENT_REQUIRED_RE =
  /402 Payment Required.*?—\s*([\d.]+)\s+([A-Z]{3,5})/i;
const PAYMENT_SIGNED_RE = /Payment signed,?\s*retrying/i;
const PAYMENT_FAILED_RE = /Payment\s*(failed|rejected|error)/i;
const HTTP_STATUS_HINT_RE = /\b(?:status|http_code|HTTP\/[\d.]+)\s*[:=]?\s*(\d{3})\b/;

export type Outcome =
  | "success"
  | "server_error"   // upstream returned 5xx after payment succeeded
  | "client_error"   // upstream returned 4xx after payment succeeded (incl. 422)
  | "payment_failed" // payment leg itself never settled
  | "tool_error";    // pay spawned, no payment attempted, wrapped tool exited non-zero

export interface PaymentSummary {
  attempted: boolean;       // did pay try to pay at all?
  signed: boolean;          // did pay print the "Payment signed" verbose line?
  amount: string | null;    // human-readable amount, e.g. "0.05"
  asset: string | null;     // human-readable asset, e.g. "USDC"
}

export interface ClassifyInput {
  payExitCode: number;
  stdoutText: string;
  stderrText: string;
}

export interface ClassifyResult {
  outcome: Outcome;
  payment: PaymentSummary;
  upstreamStatus: number | null;
  // A short, structured reason useful for [pact] summary lines and
  // settlement events. Empty string when outcome is "success".
  reason: string;
}

export function classifyPayResult(input: ClassifyInput): ClassifyResult {
  const combined = `${input.stderrText}\n${input.stdoutText}`;

  // 1. Payment metadata
  const matchAmount = combined.match(PAYMENT_REQUIRED_RE);
  const attempted = matchAmount !== null;
  const amount = matchAmount ? matchAmount[1] : null;
  const asset = matchAmount ? matchAmount[2].toUpperCase() : null;
  const signed = PAYMENT_SIGNED_RE.test(combined);
  const failed = PAYMENT_FAILED_RE.test(combined);

  // 2. Payment-leg failure short-circuit
  if (failed || (attempted && !signed && input.payExitCode !== 0)) {
    return {
      outcome: "payment_failed",
      payment: { attempted, signed: false, amount, asset },
      upstreamStatus: null,
      reason: "pay payment leg did not settle",
    };
  }

  // 3. Upstream status — best-effort. Prefer an explicit status hint in
  //    stdout (e.g. curl -w "%{http_code}") over curl's exit code, which
  //    is unreliable without -f.
  const statusMatch = input.stdoutText.match(HTTP_STATUS_HINT_RE);
  const upstreamStatus = statusMatch ? Number(statusMatch[1]) : null;

  // curl's exit-22 means "HTTP response > 400 with --fail/-f set"; we
  // treat that as a hint of 4xx/5xx when no explicit status was found.
  // Anything non-zero AND non-22 after payment signed = network error
  // → classify as server_error so the policy fires.
  if (upstreamStatus !== null) {
    if (upstreamStatus >= 500) {
      return {
        outcome: "server_error",
        payment: { attempted, signed, amount, asset },
        upstreamStatus,
        reason: `upstream ${upstreamStatus}`,
      };
    }
    if (upstreamStatus >= 400) {
      return {
        outcome: "client_error",
        payment: { attempted, signed, amount, asset },
        upstreamStatus,
        reason: `upstream ${upstreamStatus}`,
      };
    }
    // 2xx/3xx → fall through to success.
  } else if (attempted && signed && input.payExitCode !== 0) {
    // Paid, signed, but pay still exited non-zero → upstream error.
    // Without an explicit status code we cannot tell 4xx vs 5xx, so
    // bias to server_error (the SLA-protected case) on the assumption
    // that the operator's policy will treat a no-response as a 5xx.
    return {
      outcome: "server_error",
      payment: { attempted, signed, amount, asset },
      upstreamStatus: null,
      reason: `pay exit ${input.payExitCode} after signed payment (no status hint)`,
    };
  } else if (!attempted && input.payExitCode !== 0) {
    // pay spawned the wrapped tool, the tool exited non-zero, and no
    // payment was ever attempted (no 402 challenge encountered). Don't
    // mask this as success — surface it as a tool_error so callers
    // reading the envelope can distinguish "free call succeeded" from
    // "wrapped tool failed".
    return {
      outcome: "tool_error",
      payment: { attempted, signed, amount, asset },
      upstreamStatus,
      reason: `wrapped tool exited ${input.payExitCode}`,
    };
  }

  return {
    outcome: "success",
    payment: { attempted, signed, amount, asset },
    upstreamStatus,
    reason: "",
  };
}
