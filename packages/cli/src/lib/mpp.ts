// MPP (Machine Payments Protocol) challenge parsing per
// https://paymentauth.org/draft-solana-charge-00.html.
//
// MPP rides on top of HTTP's auth-challenge mechanism. The 402 carries
// `WWW-Authenticate: SolanaCharge realm="...", charge="<base64>"` (one or
// more values, possibly comma-joined inside a single header). The retry uses
// `Authorization: SolanaCharge credential="<base64>"`.
//
// We parse the WWW-Authenticate parameter list and base64-decode the
// `charge` parameter into a `ChargeRequest`. We do NOT build the credential
// here — that happens in pay-auth.ts using the project wallet.

export const HEADER_WWW_AUTHENTICATE = "www-authenticate";
export const HEADER_AUTHORIZATION = "authorization";
export const SCHEME_SOLANA_CHARGE = "SolanaCharge";

export interface ChargeRequest {
  amount: string;
  currency: string;
  recipient: string;
  description?: string;
  method_details?: {
    network?: string;
    recentBlockhash?: string;
    [k: string]: unknown;
  };
  // intent may be "charge" (one-shot) or "session" (Fiber channel). We treat
  // "session" as out-of-scope for v0.1.0 and surface an explicit error.
  intent?: string;
  cap?: string;
}

export interface MppChallenge {
  scheme: string; // "SolanaCharge"
  realm?: string;
  charge: ChargeRequest;
  // Raw, undecoded charge value — kept so callers can echo what they saw
  // when reporting unsupported intents (e.g. session) or debug failures.
  rawCharge: string;
}

function lookupHeaderAll(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name && v !== undefined) {
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
  }
  return out;
}

// Split a WWW-Authenticate header value into individual challenges. The
// header may contain multiple comma-separated challenges:
//   `Bearer realm="x", SolanaCharge realm="y" charge="..."`
// We naively split on top-level commas, then on whitespace before
// the first parameter. A real RFC 7235 parser is overkill — MPP servers
// always emit `SolanaCharge` with quoted parameters, and we tolerate
// commas inside quoted strings via simple state-tracking.
function splitChallenges(header: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === "\\" && i + 1 < header.length && inQuotes) {
      // Pass escape through; we'll let parseParams decode it.
      buf += ch + header[i + 1];
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      // Splitting on a bare comma between challenges. The next non-space
      // characters should look like `<scheme> <param>=...` — if they don't
      // (e.g. SolanaCharge's params themselves use commas as separators),
      // we'll merge back below.
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) parts.push(buf);

  // Merge back: a real challenge starts with a token followed by
  // whitespace-then-a-param. If a part doesn't start with a token+space, it's
  // a continuation of the previous challenge's params (which are also
  // comma-separated per RFC 7235).
  const merged: string[] = [];
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const looksLikeNewChallenge = /^[A-Za-z][A-Za-z0-9!#$%&'*+\-.^_`|~]*\s+\S/.test(
      trimmed,
    );
    if (looksLikeNewChallenge || merged.length === 0) {
      merged.push(trimmed);
    } else {
      merged[merged.length - 1] += ", " + trimmed;
    }
  }
  return merged;
}

function parseParams(rest: string): Record<string, string> {
  // Parse `key="value"[, key2="value2"]` — both quoted-string and token
  // values are accepted. Backslash-escapes inside quotes are unwrapped.
  const out: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /[\s,]/.test(rest[i])) i++;
    if (i >= rest.length) break;
    const keyStart = i;
    while (i < rest.length && /[A-Za-z0-9_\-]/.test(rest[i])) i++;
    const key = rest.slice(keyStart, i);
    if (key.length === 0) break;
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (rest[i] !== "=") break;
    i++;
    while (i < rest.length && /\s/.test(rest[i])) i++;
    let value = "";
    if (rest[i] === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === "\\" && i + 1 < rest.length) {
          value += rest[i + 1];
          i += 2;
          continue;
        }
        value += rest[i];
        i++;
      }
      if (rest[i] === '"') i++;
    } else {
      const start = i;
      while (i < rest.length && !/[\s,]/.test(rest[i])) i++;
      value = rest.slice(start, i);
    }
    out[key.toLowerCase()] = value;
  }
  return out;
}

function decodeChargeRequest(b64: string): ChargeRequest | null {
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.amount !== "string" ||
      typeof p.currency !== "string" ||
      typeof p.recipient !== "string"
    ) {
      return null;
    }
    return {
      amount: p.amount,
      currency: p.currency,
      recipient: p.recipient,
      description:
        typeof p.description === "string" ? p.description : undefined,
      method_details:
        p.method_details && typeof p.method_details === "object"
          ? (p.method_details as ChargeRequest["method_details"])
          : undefined,
      intent: typeof p.intent === "string" ? p.intent : undefined,
      cap: typeof p.cap === "string" ? p.cap : undefined,
    };
  } catch {
    return null;
  }
}

export function parseChallengesFromHeaderValues(values: string[]): MppChallenge[] {
  const out: MppChallenge[] = [];
  for (const v of values) {
    for (const raw of splitChallenges(v)) {
      const m = raw.match(/^([A-Za-z][A-Za-z0-9!#$%&'*+\-.^_`|~]*)\s+(.*)$/s);
      if (!m) continue;
      const scheme = m[1];
      if (scheme !== SCHEME_SOLANA_CHARGE) continue;
      const params = parseParams(m[2]);
      const chargeB64 = params.charge;
      if (!chargeB64) continue;
      const charge = decodeChargeRequest(chargeB64);
      if (!charge) continue;
      out.push({
        scheme,
        realm: params.realm,
        charge,
        rawCharge: chargeB64,
      });
    }
  }
  return out;
}

export function parseChallengesFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): MppChallenge[] {
  return parseChallengesFromHeaderValues(
    lookupHeaderAll(headers, HEADER_WWW_AUTHENTICATE),
  );
}

export function isSessionChallenge(c: MppChallenge): boolean {
  return c.charge.intent === "session";
}
