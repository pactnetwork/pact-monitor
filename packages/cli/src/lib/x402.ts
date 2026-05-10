// x402 challenge parsing per https://x402.org/.
//
// pact pay reuses x402's Solana "exact" scheme on the wire — we wrap a child
// command (curl in v0.1.0), and on a 402 response we lift the challenge from
// either the `X-Payment-Required` header (v2, preferred), the
// `X-Payment-Required-V1` header (legacy v1), or the JSON response body. The
// retry header is `X-PAYMENT` (v2) or `X-PAYMENT-V1` (v1).
//
// We only parse the wire format here. Building a signed retry payload lives in
// pay-auth.ts; the on-chain debit happens server-side via Pact's gateway, so
// we never assemble a versioned transaction client-side.

export const HEADER_PAYMENT_REQUIRED_V2 = "x-payment-required";
export const HEADER_PAYMENT_REQUIRED_V1 = "x-payment-required-v1";
export const HEADER_PAYMENT_V2 = "x-payment";
export const HEADER_PAYMENT_V1 = "x-payment-v1";

export const X402_VERSION_V1 = 1;
export const X402_VERSION_V2 = 2;

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  outputSchema?: unknown;
  extra?: Record<string, unknown>;
}

export interface X402Challenge {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
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
  // The header carries base64-encoded JSON. Buffer is available under Bun and
  // Node; atob would also work but Buffer round-trips non-ASCII more cleanly.
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function shapeRequirements(raw: unknown): PaymentRequirements | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Required fields per the x402 spec. We accept `payTo` OR `recipient`
  // because pay.sh's older challenges and some sandbox endpoints emit the
  // latter — the spec settled on `payTo`.
  const payTo = (r.payTo as string) ?? (r.recipient as string);
  const asset = (r.asset as string) ?? (r.currency as string);
  const maxAmount = (r.maxAmountRequired as string) ?? (r.amount as string);
  if (
    typeof r.scheme !== "string" ||
    typeof r.network !== "string" ||
    typeof maxAmount !== "string" ||
    typeof r.resource !== "string" ||
    typeof payTo !== "string" ||
    typeof asset !== "string"
  ) {
    return null;
  }
  return {
    scheme: r.scheme,
    network: r.network,
    maxAmountRequired: maxAmount,
    resource: r.resource,
    description: typeof r.description === "string" ? r.description : undefined,
    mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined,
    payTo,
    maxTimeoutSeconds:
      typeof r.maxTimeoutSeconds === "number" ? r.maxTimeoutSeconds : undefined,
    asset,
    outputSchema: r.outputSchema,
    extra:
      r.extra && typeof r.extra === "object"
        ? (r.extra as Record<string, unknown>)
        : undefined,
  };
}

function shapeChallenge(raw: unknown, defaultVersion: number): X402Challenge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const accepts = Array.isArray(r.accepts) ? r.accepts : [];
  const reqs = accepts
    .map(shapeRequirements)
    .filter((x): x is PaymentRequirements => x !== null);
  if (reqs.length === 0) return null;
  const v = typeof r.x402Version === "number" ? r.x402Version : defaultVersion;
  return {
    x402Version: v,
    error: typeof r.error === "string" ? r.error : undefined,
    accepts: reqs,
  };
}

export interface ParseInput {
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export function parseChallenge(input: ParseInput): X402Challenge | null {
  // Preference order matches pay.sh's `parse_x402_challenge_for_network` so
  // that the version we report is the one whose payload we actually parsed.
  const v2Header = lookupHeader(input.headers, HEADER_PAYMENT_REQUIRED_V2);
  if (v2Header) {
    const decoded = decodeBase64Json(v2Header);
    const c = shapeChallenge(decoded, X402_VERSION_V2);
    if (c) return c;
  }

  const v1Header = lookupHeader(input.headers, HEADER_PAYMENT_REQUIRED_V1);
  if (v1Header) {
    const decoded = decodeBase64Json(v1Header);
    const c = shapeChallenge(decoded, X402_VERSION_V1);
    if (c) return c;
  }

  if (input.body && input.body.trim().length > 0) {
    try {
      const parsed = JSON.parse(input.body);
      const c = shapeChallenge(parsed, X402_VERSION_V2);
      if (c) return c;
    } catch {
      /* not a JSON body — caller will treat as unknown 402 */
    }
  }

  return null;
}

export function selectSolanaRequirements(
  challenge: X402Challenge,
  preferredNetwork?: string,
): PaymentRequirements | null {
  // x402 networks for Solana are the slugs `solana`, `solana-devnet`,
  // `solana-testnet`, plus CAIP-2 chain IDs prefixed `solana:`.
  const isSolana = (n: string) =>
    n === "solana" ||
    n === "solana-devnet" ||
    n === "solana-testnet" ||
    n.startsWith("solana:");
  const candidates = challenge.accepts.filter((r) => isSolana(r.network));
  if (candidates.length === 0) return null;
  if (preferredNetwork) {
    const exact = candidates.find((r) => r.network === preferredNetwork);
    if (exact) return exact;
  }
  return candidates[0];
}

export function isPaymentRejection(input: ParseInput): {
  rejected: boolean;
  reason?: string;
} {
  // x402 verifiers respond with status 402 + a body describing why the
  // previously-submitted payment was rejected (wrong network, expired,
  // double-spend). pay.sh treats this as PaymentRejected. Body shape:
  // { error: "verification_failed", reason: "..." }
  if (!input.body) return { rejected: false };
  try {
    const parsed = JSON.parse(input.body) as Record<string, unknown>;
    if (parsed.error === "verification_failed") {
      return {
        rejected: true,
        reason:
          typeof parsed.reason === "string"
            ? parsed.reason
            : "verification_failed",
      };
    }
  } catch {
    /* not JSON */
  }
  return { rejected: false };
}
