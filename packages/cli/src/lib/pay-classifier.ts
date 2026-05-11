// Post-pay classifier. After `pay <args>` exits, this inspects the
// captured streams + exit code and decides whether Pact would refund
// the call under its standard SLA policy.
//
// Signals we look for (verified against solana-foundation/pay 0.16.0
// output, both verbose and non-verbose, captured 2026-05-11 — see
// fixtures under packages/cli/test/fixtures/pay-016/):
//
//   x402 challenge (verbose):
//     "402 Payment Required (x402) — N USDC"   ← unconditional on the
//                                              auto-pay path; tells us a
//                                              payment was attempted and
//                                              extracts the amount.
//     "Paying..."                              ← verbose-only.
//     "Payment signed, retrying..."            ← verbose-only; confirms
//                                              the payment succeeded.
//
//   MPP challenge (verbose only — pay-core tracing):
//     "Detected MPP challenge"                 ← challenge accepted.
//     "Selected MPP challenge ... amount=N currency=<mint>"
//     "Building MPP credential amount=N currency=<mint>"
//                                              ← amount in micro-units,
//                                              currency is the SPL mint.
//
//   Failure (either protocol):
//     "Payment failed:", "Payment rejected", "Payment Verification Error",
//     "Server returned 402 again after payment"
//
// Non-verbose mode emits nothing on stderr for either protocol; the
// classifier can only report payment.attempted=true when the user passes
// `-v` to pay. The wrap-summary line still describes the upstream HTTP
// outcome correctly in either mode.
//
// Upstream HTTP status: when the wrapped tool is curl, pay forwards
// curl's exit code as its own. curl returns 0 on a 2xx, 22 on a 4xx/5xx
// (only if -f was supplied), and various non-zero codes for network
// errors. Without -f, curl exits 0 even on a 5xx and writes the body to
// stdout — so we ALSO scan the captured stdout for an HTTP status
// hint (e.g. `-w "%{http_code}"` or a JSON-RPC error envelope) when
// possible.

// Canonical USDC mint on Solana mainnet — re-used as the localnet/sandbox
// alias by pay-core. When the MPP "currency=<mint>" field matches this
// value, we surface the asset as "USDC" in the summary.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

// Strip terminal ANSI escape sequences. pay -v emits color codes even
// when stderr is redirected to a file, so the fixture captures (and
// real-world tee'd buffers) contain `\x1b[...m` runs that would defeat
// naive regex anchoring.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Legacy x402 verbose line: "402 Payment Required (x402) — N USDC". The
// parenthetical "(x402)" contains the digits "402" which would steal
// the amount capture if we used a non-digit run. Anchor on the em-dash
// pay emits and pull the "<amount> <asset>" pair from after it.
const X402_PAYMENT_LINE_RE =
  /402 Payment Required.*?—\s*([\d.]+)\s+([A-Z]{3,5})/i;
// Same line with a plain ASCII "--" or "-" instead of em-dash, in case
// pay's output format ever drops the unicode dash.
const X402_PAYMENT_LINE_ASCII_RE =
  /402 Payment Required.*?[-]{1,2}\s*([\d.]+)\s+([A-Z]{3,5})/i;

// pay 0.16.0 MPP verbose tracing: pay-core emits the "Detected MPP
// challenge" line on every MPP auto-pay, then "Building MPP credential
// amount=N currency=<mint>" once it picks a denomination. We use the
// detection line as the "attempted" signal and the build line for
// amount/asset extraction.
const MPP_DETECTED_RE = /Detected\s+MPP\s+challenge/i;
const MPP_AMOUNT_RE =
  /Building\s+MPP\s+credential\b[^\n]*?\bamount=(\d+)[^\n]*?\bcurrency=([A-Za-z0-9]+)/i;

// x402 detection signal (verbose pay-core trace) — present on the x402
// auto-pay path even before the "402 Payment Required" body line.
const X402_DETECTED_RE = /Detected\s+x402\s+challenge/i;

const PAYMENT_SIGNED_RE = /Payment\s+signed,?\s*retrying/i;
const PAYMENT_FAILED_RE =
  /(?:Payment\s*(?:failed|rejected|error)|Payment\s+Verification\s+Error|Server\s+returned\s+402\s+again\s+after\s+payment)/i;

const HTTP_STATUS_HINT_RE = /\b(?:status|http_code|HTTP\/[\d.]+)\s*[:=]?\s*(\d{3})\b/;

export type Outcome =
  | "success"
  | "server_error"   // upstream returned 5xx after payment succeeded
  | "client_error"   // upstream returned 4xx after payment succeeded (incl. 422)
  | "payment_failed"; // payment leg itself never settled

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

function formatMicroAmount(rawMicro: string, decimals: number): string {
  // Promote micro-units (e.g. "10000" for USDC@6) to a human-readable
  // decimal string with trailing-zero trimming. Falls back to the raw
  // value on parse failure rather than throwing.
  const n = BigInt(rawMicro);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = n / base;
  const frac = n % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length === 0 ? whole.toString() : `${whole}.${fracStr}`;
}

function extractPaymentMetadata(combined: string): {
  attempted: boolean;
  amount: string | null;
  asset: string | null;
} {
  // Try x402 legacy line first (em-dash, then ASCII dash fallback).
  const x402Match =
    combined.match(X402_PAYMENT_LINE_RE) ??
    combined.match(X402_PAYMENT_LINE_ASCII_RE);
  if (x402Match) {
    return {
      attempted: true,
      amount: x402Match[1],
      asset: x402Match[2].toUpperCase(),
    };
  }

  // MPP verbose tracing: detect first, then attempt to extract the
  // amount/currency from the credential-build line.
  if (MPP_DETECTED_RE.test(combined)) {
    const mppAmount = combined.match(MPP_AMOUNT_RE);
    if (mppAmount) {
      const raw = mppAmount[1];
      const mint = mppAmount[2];
      const isUsdc = mint === USDC_MINT;
      return {
        attempted: true,
        amount: isUsdc ? formatMicroAmount(raw, USDC_DECIMALS) : raw,
        asset: isUsdc ? "USDC" : mint,
      };
    }
    return { attempted: true, amount: null, asset: null };
  }

  // x402 verbose detection without a "402 Payment Required" body line
  // — still tells us a payment was attempted, but we cannot extract
  // amount/asset without the body line.
  if (X402_DETECTED_RE.test(combined)) {
    return { attempted: true, amount: null, asset: null };
  }

  return { attempted: false, amount: null, asset: null };
}

export function classifyPayResult(input: ClassifyInput): ClassifyResult {
  const combined = stripAnsi(`${input.stderrText}\n${input.stdoutText}`);

  // 1. Payment metadata
  const { attempted, amount, asset } = extractPaymentMetadata(combined);
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
  const stdoutClean = stripAnsi(input.stdoutText);
  const statusMatch = stdoutClean.match(HTTP_STATUS_HINT_RE);
  const upstreamStatus = statusMatch ? Number(statusMatch[1]) : null;

  // For MPP/x402 verbose paths, pay does the payment in-flight and exits
  // 0 on success — there's no explicit "Payment signed, retrying" line
  // for MPP. Treat attempted + exit 0 + no failure marker as signed.
  const effectivelySigned =
    signed || (attempted && !failed && input.payExitCode === 0);

  // curl's exit-22 means "HTTP response > 400 with --fail/-f set"; we
  // treat that as a hint of 4xx/5xx when no explicit status was found.
  // Anything non-zero AND non-22 after payment signed = network error
  // → classify as server_error so the policy fires.
  if (upstreamStatus !== null) {
    if (upstreamStatus >= 500) {
      return {
        outcome: "server_error",
        payment: { attempted, signed: effectivelySigned, amount, asset },
        upstreamStatus,
        reason: `upstream ${upstreamStatus}`,
      };
    }
    if (upstreamStatus >= 400) {
      return {
        outcome: "client_error",
        payment: { attempted, signed: effectivelySigned, amount, asset },
        upstreamStatus,
        reason: `upstream ${upstreamStatus}`,
      };
    }
    // 2xx/3xx → fall through to success.
  } else if (attempted && effectivelySigned && input.payExitCode !== 0) {
    // Paid, signed, but pay still exited non-zero → upstream error.
    // Without an explicit status code we cannot tell 4xx vs 5xx, so
    // bias to server_error (the SLA-protected case) on the assumption
    // that the operator's policy will treat a no-response as a 5xx.
    return {
      outcome: "server_error",
      payment: { attempted, signed: effectivelySigned, amount, asset },
      upstreamStatus: null,
      reason: `pay exit ${input.payExitCode} after signed payment (no status hint)`,
    };
  }

  return {
    outcome: "success",
    payment: { attempted, signed: effectivelySigned, amount, asset },
    upstreamStatus,
    reason: "",
  };
}
