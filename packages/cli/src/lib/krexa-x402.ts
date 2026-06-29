// Krexa Compute Gateway x402 variant.
//
// Krexa's x402-published services (per docs/builders/publishing-x402-service.md
// at krexa.mintlify.app) emit a `PAYMENT-REQUIRED` header — no `X-` prefix,
// distinct from x402.org's canonical `X-Payment-Required`. The retry carries
// the on-chain USDC transfer proof in TWO headers: `PAYMENT-SIGNATURE` and
// `X-Payment-Token`, both set to `base64(JSON.stringify({signature: <txSig>}))`.
// This matches @krexa/cli@0.2.8's `krexa x402 call` retry behaviour
// (dist/commands/x402.js), which sends both header names with the same
// base64-JSON token value.
//
// Settlement model is per-request on-chain (not allowance-based like Pact
// Network): the client builds a USDC SPL transfer from its ATA to the
// gateway's `payTo`, signs, submits, then retries with the resulting tx
// signature as proof. The Krexa server verifies the transfer landed on-chain
// before serving the response.

const HEADER_KREXA_PAYMENT_REQUIRED = "payment-required";
export const HEADER_KREXA_RETRY = "PAYMENT-SIGNATURE";
export const HEADER_KREXA_RETRY_TOKEN = "X-Payment-Token";

// Build the retry header value the Krexa publishing-x402-service spec
// expects: base64(JSON.stringify({signature})). Both PAYMENT-SIGNATURE
// and X-Payment-Token carry the same value, mirroring @krexa/cli's
// x402.js (dist/commands/x402.js → "krexa x402 call" emits both with the
// identical base64 token).
export function buildKrexaRetryHeaders(signature: string): {
  value: string;
  paymentSignature: string;
  xPaymentToken: string;
} {
  const value = Buffer.from(
    JSON.stringify({ signature }),
    "utf8",
  ).toString("base64");
  return {
    value,
    paymentSignature: value,
    xPaymentToken: value,
  };
}

export interface KrexaPaymentRequirements {
  scheme: string;
  network: string;
  amountBaseUnits: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

export interface KrexaChallenge {
  x402Version: number;
  accepts: KrexaPaymentRequirements[];
  resource?: { url?: string; description?: string };
}

function lookupHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name && v !== undefined) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function decodeBase64Json(value: string): unknown {
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function shapeRequirements(raw: unknown): KrexaPaymentRequirements | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Krexa's publishing template uses the x402 "exact" scheme over Solana with
  // `amount` in base units (string), `asset` as the SPL mint, and `payTo` as
  // the recipient pubkey. Older drafts used `recipient`/`maxAmountRequired`;
  // accept both for forward/backward compatibility.
  const amount = (r.amount as string) ?? (r.maxAmountRequired as string);
  const payTo = (r.payTo as string) ?? (r.recipient as string);
  if (
    typeof r.scheme !== "string" ||
    typeof r.network !== "string" ||
    typeof amount !== "string" ||
    typeof r.asset !== "string" ||
    typeof payTo !== "string"
  ) {
    return null;
  }
  return {
    scheme: r.scheme,
    network: r.network,
    amountBaseUnits: amount,
    asset: r.asset,
    payTo,
    maxTimeoutSeconds:
      typeof r.maxTimeoutSeconds === "number" ? r.maxTimeoutSeconds : undefined,
  };
}

function shapeChallenge(raw: unknown): KrexaChallenge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const accepts = Array.isArray(r.accepts) ? r.accepts : [];
  const reqs = accepts
    .map(shapeRequirements)
    .filter((x): x is KrexaPaymentRequirements => x !== null);
  if (reqs.length === 0) return null;
  return {
    x402Version: typeof r.x402Version === "number" ? r.x402Version : 2,
    accepts: reqs,
    resource:
      r.resource && typeof r.resource === "object"
        ? (r.resource as KrexaChallenge["resource"])
        : undefined,
  };
}

export interface ParseInput {
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export function parseKrexaChallenge(input: ParseInput): KrexaChallenge | null {
  const headerVal = lookupHeader(input.headers, HEADER_KREXA_PAYMENT_REQUIRED);
  if (headerVal) {
    const decoded = decodeBase64Json(headerVal);
    const c = shapeChallenge(decoded);
    if (c) return c;
  }
  if (input.body && input.body.trim().length > 0) {
    try {
      const parsed = JSON.parse(input.body);
      const c = shapeChallenge(parsed);
      if (c) return c;
    } catch {
      /* body is not JSON */
    }
  }
  return null;
}

export function selectKrexaSolanaRequirements(
  challenge: KrexaChallenge,
  preferredNetwork?: string,
): KrexaPaymentRequirements | null {
  const isSolana = (n: string) =>
    n === "solana" ||
    n === "solana-devnet" ||
    n === "solana-mainnet-beta" ||
    n.startsWith("solana:");
  const candidates = challenge.accepts.filter((r) => isSolana(r.network));
  if (candidates.length === 0) return null;
  if (preferredNetwork) {
    const exact = candidates.find((r) => r.network === preferredNetwork);
    if (exact) return exact;
  }
  return candidates[0];
}
