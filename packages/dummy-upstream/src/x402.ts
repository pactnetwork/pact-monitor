// x402 "Payment Required" challenge helper.
//
// pact-cli does NOT parse x402 challenges itself — `pact pay` delegates to
// solana-foundation/pay, which speaks the wire format. There is no x402
// parser in this repo to mirror, so this implements the public x402 v1
// challenge shape (the `accepts` array described at https://x402.org and in
// the coinbase/x402 reference implementation):
//
//   HTTP/1.1 402 Payment Required
//   Content-Type: application/json
//
//   {
//     "x402Version": 1,
//     "error": "payment_required",
//     "accepts": [
//       {
//         "scheme": "exact",
//         "network": "solana",
//         "asset": "<USDC mint>",
//         "payTo": "<recipient pubkey>",
//         "maxAmountRequired": "5000",     // atomic units (USDC has 6 dp → 0.005 USDC)
//         "resource": "<the URL that was 402'd>",
//         "description": "...",
//         "mimeType": "application/json",
//         "maxTimeoutSeconds": 60
//       }
//     ]
//   }
//
// We additionally emit a best-effort `PAYMENT-REQUIRED` response header
// carrying the base64 of the first `accepts` entry, mirroring the casing the
// monitor's payment-extractor looks for on the response side
// (`PAYMENT-RESPONSE` / `PAYMENT-RECEIPT`). A `WWW-Authenticate: x402` header
// is also set so generic HTTP clients see a challenge scheme.
//
// Network / asset constants below are the canonical Solana mainnet values —
// they are placeholders for a demo, no real funds move.

// Canonical USDC mint on Solana mainnet.
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Solana mainnet CAIP-2-ish chain id (used by x402's solana facilitators).
export const SOLANA_NETWORK = "solana";
// Demo x402 recipient pubkey. Override with the DUMMY_X402_PAY_TO env var
// (e.g. on the Vercel project) to point mainnet `pact pay` payments at a real
// treasury you control. The default below is a valid 32-byte Solana pubkey but
// is NOT controlled by anyone — fine for `--sandbox` (localnet, fake USDC);
// for a MAINNET demo, set DUMMY_X402_PAY_TO to a recoverable address first.
export const DEMO_PAY_TO =
  process.env.DUMMY_X402_PAY_TO ?? "PactDemoUpstreamPayTo1111111111111111111111";
// Atomic USDC units. 5000 / 1e6 = 0.005 USDC.
export const DEMO_MAX_AMOUNT_REQUIRED = "5000";

export interface X402Accept {
  scheme: "exact";
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
}

export interface X402Challenge {
  x402Version: 1;
  error: "payment_required";
  accepts: X402Accept[];
}

export function buildX402Accept(resourceUrl: string): X402Accept {
  return {
    scheme: "exact",
    network: SOLANA_NETWORK,
    asset: USDC_MINT,
    payTo: DEMO_PAY_TO,
    maxAmountRequired: DEMO_MAX_AMOUNT_REQUIRED,
    resource: resourceUrl,
    description: "pact-dummy-upstream demo x402 paywall (no real funds move)",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
  };
}

export function buildX402Challenge(resourceUrl: string): X402Challenge {
  return {
    x402Version: 1,
    error: "payment_required",
    accepts: [buildX402Accept(resourceUrl)],
  };
}

// base64 of the JSON of a single accept entry — emitted on the
// `PAYMENT-REQUIRED` header for clients that read the challenge from a
// header rather than the body.
export function encodeAcceptHeader(accept: X402Accept): string {
  return Buffer.from(JSON.stringify(accept), "utf8").toString("base64");
}
