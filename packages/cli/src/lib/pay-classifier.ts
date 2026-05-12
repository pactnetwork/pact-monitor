// Post-pay classifier. After `pay <args>` exits, this inspects the
// captured streams + exit code and decides whether Pact would refund
// the call under its standard SLA policy.
//
// Signals we look for (verified against solana-foundation/pay 0.16.0
// output, both verbose and non-verbose, captured 2026-05-11 — see
// fixtures under packages/cli/test/fixtures/pay-016/):
//
//   x402 challenge (verbose):
//     "Detected x402 challenge resource=\"<url>\""  ← scheme=x402, resource.
//     "402 Payment Required (x402) — N USDC"   ← unconditional on the
//                                              auto-pay path; tells us a
//                                              payment was attempted and
//                                              extracts the amount.
//     "Paying..."                              ← verbose-only.
//     "Payment signed, retrying..."            ← verbose-only; confirms
//                                              the payment succeeded.
//
//   MPP challenge (verbose only — pay-core tracing):
//     "Detected MPP challenge … resource=\"<url>\""  ← scheme=mpp, resource.
//     "Selected MPP challenge ... amount=N currency=<mint>"
//     "Building MPP credential amount=N currency=<mint> … signer=<pubkey>"
//                                              ← amount in micro-units,
//                                              currency is the SPL mint,
//                                              signer is the agent pubkey.
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
// What pay 0.16.0 does NOT expose, even verbose: the merchant/payee
// address and the on-chain settle transaction signature. The facilitator
// side-call handles those being absent (it can re-derive the payee from
// the 402 challenge it never saw — i.e. it can't, and treats them as
// partial data). See packages/cli/src/lib/x402-receipt.ts.
//
// Upstream HTTP status: when the wrapped tool is curl, pay forwards
// curl's exit code as its own. curl returns 0 on a 2xx, 22 on a 4xx/5xx
// (only if -f was supplied), and various non-zero codes for network
// errors. Without -f, curl exits 0 even on a 5xx and writes the body to
// stdout — so `pact pay` injects `-w '\n[pact-http-status=%{http_code}]\n'`
// into curl's argv (see pay-shell.ts withCurlStatusMarker) and we scan
// the captured stdout for that `[pact-http-status=…]` marker first
// (PACT_HTTP_STATUS_RE), falling back to a generic status hint (a stray
// `http_code=`/`status:` token, or a JSON-RPC error envelope). Without
// the marker a 5xx would be misclassified `success` and the
// `server_error → refund` path would never fire via `pact pay curl`.

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
// auto-pay path even before the "402 Payment Required" body line. pay
// 0.13.0/0.16.0 phrases this as "Detected x402 challenge (Solana)".
const X402_DETECTED_RE = /Detected\s+x402\s+challenge/i;

// pay 0.13.0/0.16.0 x402 auto-pay credential-build line. The hosted
// `pay curl '<url>?x402=1'` path emits (verbose, stderr):
//
//   Building x402 payment amount=5000 currency=<mint> cluster=mainnet recipient=<pubkey> signer=<pubkey>
//
// Unlike the legacy "402 Payment Required (x402) — N USDC" body line,
// this carries the amount ALREADY in base units, the SPL mint, the
// merchant address (`recipient=` — this is the payee!), and the agent's
// own signer pubkey. The fields are order-independent and we tolerate
// extra fields (e.g. `cluster=`) between them, matching both the 0.13
// and 0.16 output formats. The amount is a plain integer (base units);
// currency / recipient / signer are base58 pubkeys.
const X402_BUILD_LINE_RE = /Building\s+x402\s+payment\b/i;
const X402_BUILD_AMOUNT_RE = /Building\s+x402\s+payment\b[^\n]*?\bamount=(\d+)\b/i;
const X402_BUILD_CURRENCY_RE =
  /Building\s+x402\s+payment\b[^\n]*?\bcurrency=([1-9A-HJ-NP-Za-km-z]{32,44})\b/i;
const X402_BUILD_RECIPIENT_RE =
  /Building\s+x402\s+payment\b[^\n]*?\brecipient=([1-9A-HJ-NP-Za-km-z]{32,44})\b/i;
// (`signer=` on this same line is matched by SIGNER_HINT_RE below — no
// separate regex needed.)

// Both the x402 and MPP "Detected … challenge" verbose lines carry the
// resource pay paid for: `… resource="https://example.x402/quote/AAPL"`.
// Pull it best-effort so the facilitator side-call can name the covered
// resource without re-deriving it from the wrapped tool's argv (which we
// deliberately don't parse). Falls back to null.
const RESOURCE_HINT_RE = /\bresource\s*=\s*"([^"]+)"/i;

// pay 0.16.0 logs the signer (the agent's own Solana pubkey) on the
// MPP/x402 settle path: `… signer=<base58>`. This is NOT the on-chain
// settle transaction signature — pay 0.16.0's verbose output does not
// surface that in any captured fixture. We extract `signer=` so the
// facilitator can cross-check it against the x-pact-agent header, and
// best-effort scan for an explicit `signature=`/`tx=` hint in case a
// future pay build adds the settle tx sig to its trace.
const SIGNER_HINT_RE = /\bsigner\s*=\s*([1-9A-HJ-NP-Za-km-z]{32,44})\b/i;
const TX_SIGNATURE_HINT_RE =
  /\b(?:tx_signature|tx_sig|signature|tx)\s*[:=]\s*([1-9A-HJ-NP-Za-km-z]{64,88})\b/i;

// pay 0.16.0 names the SPL mint it paid in as `currency=<mint>` on the
// MPP path. The x402 legacy body line ("… — 0.05 USDC") only gives the
// symbol, not the mint.
const CURRENCY_MINT_RE = /\bcurrency\s*=\s*([1-9A-HJ-NP-Za-km-z]{32,44})\b/i;

const PAYMENT_SIGNED_RE = /Payment\s+signed,?\s*retrying/i;
const PAYMENT_FAILED_RE =
  /(?:Payment\s*(?:failed|rejected|error)|Payment\s+Verification\s+Error|Server\s+returned\s+402\s+again\s+after\s+payment)/i;

const HTTP_STATUS_HINT_RE = /\b(?:status|http_code|HTTP\/[\d.]+)\s*[:=]?\s*(\d{3})\b/;

// The status marker pact injects into curl's output via `-w` (see
// pay-shell.ts withCurlStatusMarker): `[pact-http-status=503]`. This is
// the authoritative upstream HTTP status when present — `pact pay curl`
// runs plain curl, which forwards exit 0 even on a 5xx, so without this
// marker the classifier would call a 5xx `success` and the
// `server_error → refund` path would never fire. Checked before the
// generic HTTP_STATUS_HINT_RE so it wins over any incidental
// `http_code=`/`status:` text in a response body.
const PACT_HTTP_STATUS_RE = /\[pact-http-status=(\d{3})\]/;

// pay does not yet print the call latency in any captured fixture, but
// some builds log `latency_ms=N` / `elapsed=Nms` on the retry line.
// Scan best-effort; null when absent.
const LATENCY_HINT_RE = /\b(?:latency_ms|latency|elapsed)\s*[:=]\s*(\d+)\s*(?:ms)?\b/i;

export type Outcome =
  | "success"
  | "server_error"   // upstream returned 5xx after payment succeeded
  | "client_error"   // upstream returned 4xx after payment succeeded (incl. 422)
  | "payment_failed" // payment leg itself never settled
  | "tool_error";    // pay spawned, no payment attempted, wrapped tool exited non-zero

// Which 402 protocol pay used. "unknown" when a payment was attempted
// but neither protocol's trace markers were found (e.g. -v suppressed by
// the wrapped tool's own quiet flag).
export type PaymentScheme = "x402" | "mpp" | "unknown";

export interface PaymentSummary {
  attempted: boolean;       // did pay try to pay at all?
  signed: boolean;          // did pay print the "Payment signed" verbose line?
  amount: string | null;    // human-readable amount, e.g. "0.05"
  asset: string | null;     // human-readable asset, e.g. "USDC"
  // 402 protocol pay used. Present whenever `attempted` is true.
  scheme?: PaymentScheme;
  // The SPL mint pay paid in, base58, when pay logged it (`currency=`).
  // Null when pay only gave a symbol (the x402 legacy body line) or no
  // mint at all.
  assetMint?: string | null;
  // The payment amount in the asset's smallest unit, as a decimal
  // string, when pay logged it numerically (`amount=` on the MPP path,
  // or the x402 body amount × 10^decimals when the asset is a known
  // mint). Null otherwise.
  amountBaseUnits?: string | null;
  // The resource (URL) pay paid for, from the `resource="…"` trace
  // field. Null when pay didn't log it.
  resource?: string | null;
  // The signer pay used (the agent's own pubkey), base58. Null when not
  // logged. NOT the merchant/payee.
  signerPubkey?: string | null;
  // The merchant/payee address from the x402 challenge, base58. pay
  // 0.13.0/0.16.0 logs this as `recipient=` on the x402 "Building x402
  // payment" credential-build line; the MPP path and the legacy x402
  // body line do not surface it. Null when not logged.
  payeePubkey?: string | null;
  // The on-chain settle transaction signature, base58. pay 0.16.0 does
  // NOT log this in any captured fixture — this is always null today and
  // exists so a future pay build that adds it lights up automatically.
  txSignature?: string | null;
  // The call latency in ms, when pay logged it. Null otherwise.
  latencyMs?: number | null;
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

// Promote a human-readable decimal amount (e.g. "0.05") to base units in
// the given decimals (e.g. "50000" at 6 decimals). Returns null on a
// parse failure rather than throwing.
function toBaseUnits(decimalAmount: string, decimals: number): string | null {
  const m = decimalAmount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const whole = m[1];
  const frac = (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  try {
    const base = BigInt(10) ** BigInt(decimals);
    return (BigInt(whole) * base + BigInt(frac || "0")).toString();
  } catch {
    return null;
  }
}

interface ExtractedPaymentMeta {
  attempted: boolean;
  amount: string | null;
  asset: string | null;
  scheme: PaymentScheme;
  assetMint: string | null;
  amountBaseUnits: string | null;
  // The merchant address from the x402 build line (`recipient=`), base58.
  // Null on every path except the x402 "Building x402 payment" line.
  payeePubkey: string | null;
}

function extractPaymentMetadata(combined: string): ExtractedPaymentMeta {
  const mintMatch = combined.match(CURRENCY_MINT_RE);
  const assetMintFromCurrency = mintMatch ? mintMatch[1] : null;

  // x402 auto-pay credential-build line (pay 0.13.0/0.16.0):
  //   "Building x402 payment amount=5000 currency=<mint> cluster=… recipient=<pk> signer=<pk>"
  // This is what the hosted `pay curl '<url>?x402=1'` path actually
  // emits (the legacy "402 Payment Required (x402) — N USDC" body line
  // is NOT printed by `pay curl`, which echoes the final 200 body, not
  // the 402 challenge). Prefer it: it carries the amount in base units,
  // the SPL mint, AND the merchant address (`recipient=`).
  if (X402_BUILD_LINE_RE.test(combined)) {
    const amtMatch = combined.match(X402_BUILD_AMOUNT_RE);
    const curMatch = combined.match(X402_BUILD_CURRENCY_RE);
    const recMatch = combined.match(X402_BUILD_RECIPIENT_RE);
    const raw = amtMatch ? amtMatch[1] : null;
    const mint = (curMatch ? curMatch[1] : null) ?? assetMintFromCurrency;
    const isUsdc = mint === USDC_MINT;
    return {
      attempted: true,
      // `amount=` here is already in base units; promote to a
      // human-readable decimal only when we know the mint's decimals.
      amount:
        raw === null
          ? null
          : isUsdc
            ? formatMicroAmount(raw, USDC_DECIMALS)
            : raw,
      asset: isUsdc ? "USDC" : mint,
      scheme: "x402",
      assetMint: mint,
      amountBaseUnits: raw,
      payeePubkey: recMatch ? recMatch[1] : null,
    };
  }

  // Try x402 legacy line first (em-dash, then ASCII dash fallback).
  const x402Match =
    combined.match(X402_PAYMENT_LINE_RE) ??
    combined.match(X402_PAYMENT_LINE_ASCII_RE);
  if (x402Match) {
    const amount = x402Match[1];
    const asset = x402Match[2].toUpperCase();
    // The x402 body line gives a symbol, not a mint. If the symbol is
    // USDC we can derive base units from the canonical 6-decimal value;
    // otherwise we leave amountBaseUnits null (the facilitator can't
    // trust a guessed scale).
    const amountBaseUnits =
      asset === "USDC" ? toBaseUnits(amount, USDC_DECIMALS) : null;
    return {
      attempted: true,
      amount,
      asset,
      scheme: "x402",
      assetMint:
        assetMintFromCurrency ?? (asset === "USDC" ? USDC_MINT : null),
      amountBaseUnits,
      payeePubkey: null,
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
        scheme: "mpp",
        assetMint: mint,
        // `amount=` on the MPP path is already in base units.
        amountBaseUnits: raw,
        payeePubkey: null,
      };
    }
    return {
      attempted: true,
      amount: null,
      asset: null,
      scheme: "mpp",
      assetMint: assetMintFromCurrency,
      amountBaseUnits: null,
      payeePubkey: null,
    };
  }

  // x402 verbose detection without a "402 Payment Required" body line
  // — still tells us a payment was attempted, but we cannot extract
  // amount/asset without the body line.
  if (X402_DETECTED_RE.test(combined)) {
    return {
      attempted: true,
      amount: null,
      asset: null,
      scheme: "x402",
      assetMint: assetMintFromCurrency,
      amountBaseUnits: null,
      payeePubkey: null,
    };
  }

  return {
    attempted: false,
    amount: null,
    asset: null,
    scheme: "unknown",
    assetMint: null,
    amountBaseUnits: null,
    payeePubkey: null,
  };
}

function extractTransportHints(combined: string): {
  resource: string | null;
  signerPubkey: string | null;
  txSignature: string | null;
  latencyMs: number | null;
} {
  const resMatch = combined.match(RESOURCE_HINT_RE);
  const signerMatch = combined.match(SIGNER_HINT_RE);
  const txMatch = combined.match(TX_SIGNATURE_HINT_RE);
  const latMatch = combined.match(LATENCY_HINT_RE);
  return {
    resource: resMatch ? resMatch[1] : null,
    signerPubkey: signerMatch ? signerMatch[1] : null,
    txSignature: txMatch ? txMatch[1] : null,
    latencyMs: latMatch ? Number(latMatch[1]) : null,
  };
}

export function classifyPayResult(input: ClassifyInput): ClassifyResult {
  const combined = stripAnsi(`${input.stderrText}\n${input.stdoutText}`);

  // 1. Payment metadata
  const pm = extractPaymentMetadata(combined);
  const { attempted, amount, asset } = pm;
  const hints = attempted
    ? extractTransportHints(combined)
    : { resource: null, signerPubkey: null, txSignature: null, latencyMs: null };
  const signed = PAYMENT_SIGNED_RE.test(combined);
  const failed = PAYMENT_FAILED_RE.test(combined);

  const baseSummary = (signedFlag: boolean): PaymentSummary => ({
    attempted,
    signed: signedFlag,
    amount,
    asset,
    ...(attempted
      ? {
          scheme: pm.scheme,
          assetMint: pm.assetMint,
          amountBaseUnits: pm.amountBaseUnits,
          resource: hints.resource,
          // `signer=` from the x402 build line is picked up by
          // SIGNER_HINT_RE in extractTransportHints already.
          signerPubkey: hints.signerPubkey,
          payeePubkey: pm.payeePubkey,
          txSignature: hints.txSignature,
          latencyMs: hints.latencyMs,
        }
      : {}),
  });

  // 2. Payment-leg failure short-circuit
  if (failed || (attempted && !signed && input.payExitCode !== 0)) {
    return {
      outcome: "payment_failed",
      payment: baseSummary(false),
      upstreamStatus: null,
      reason: "pay payment leg did not settle",
    };
  }

  // 3. Upstream status — best-effort. Prefer an explicit status hint in
  //    stdout (e.g. curl -w "%{http_code}") over curl's exit code, which
  //    is unreliable without -f.
  const stdoutClean = stripAnsi(input.stdoutText);
  // Prefer pact's own injected `[pact-http-status=…]` marker (curl `-w`)
  // over a generic status-looking token in the response body.
  const pactStatusMatch = stdoutClean.match(PACT_HTTP_STATUS_RE);
  const statusMatch = pactStatusMatch ?? stdoutClean.match(HTTP_STATUS_HINT_RE);
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
        payment: baseSummary(effectivelySigned),
        upstreamStatus,
        reason: `upstream ${upstreamStatus}`,
      };
    }
    if (upstreamStatus >= 400) {
      return {
        outcome: "client_error",
        payment: baseSummary(effectivelySigned),
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
      payment: baseSummary(effectivelySigned),
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
      payment: baseSummary(signed),
      upstreamStatus,
      reason: `wrapped tool exited ${input.payExitCode}`,
    };
  }

  return {
    outcome: "success",
    payment: baseSummary(effectivelySigned),
    upstreamStatus,
    reason: "",
  };
}
