/**
 * Signed HTTP client for merchant-side backend writes.
 *
 * Every POST carries three headers:
 *  - Authorization: Bearer <apiKey>
 *  - X-Pact-Pubkey: <merchant pubkey base58>
 *  - X-Pact-Signature: base64(ed25519(sha256(canonicalJson(body))))
 *
 * Canonical JSON = `JSON.stringify(body, Object.keys(body).sort())`, matching
 * the backend's existing `verifyObservationSignature` expectation.
 */
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { resolveSecretKey, signerPublicKey, type PactSigner } from "../signer.js";
import { PactError, PactErrorCode } from "../errors.js";

export interface MerchantClientOptions {
  signer: PactSigner;
  apiKey: string;
  backendUrl: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface MerchantClient {
  readonly merchantPubkey: string;
  postObservation(body: Record<string, unknown>): Promise<{
    status: number;
    body: unknown;
  }>;
  getStats(query?: Record<string, string | number>): Promise<unknown>;
  getMerchants(): Promise<unknown>;
  postRegister(body: Record<string, unknown>): Promise<unknown>;
}

function canonicalJsonHash(body: Record<string, unknown>): Buffer {
  const serialized = JSON.stringify(body, Object.keys(body).sort());
  return createHash("sha256").update(serialized).digest();
}

export function createMerchantClient(
  opts: MerchantClientOptions,
): MerchantClient {
  const merchantPubkey = signerPublicKey(opts.signer);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backend = opts.backendUrl.replace(/\/+$/, "");

  function signBody(body: Record<string, unknown>): string {
    const secret = resolveSecretKey(opts.signer);
    if (!secret) {
      throw new PactError(
        PactErrorCode.SIGNATURE_FAILED,
        "merchant signer does not expose a secret key (wallet adapter without secretKey override); cannot sign observation",
      );
    }
    const digest = canonicalJsonHash(body);
    return Buffer.from(nacl.sign.detached(digest, secret)).toString("base64");
  }

  async function postSigned(path: string, body: Record<string, unknown>) {
    const sig = signBody(body);
    const res = await fetchImpl(`${backend}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        "X-Pact-Pubkey": merchantPubkey,
        "X-Pact-Signature": sig,
      },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* body may be empty */
    }
    return { status: res.status, body: parsed };
  }

  async function getJson(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const res = await fetchImpl(`${backend}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...headers,
      },
    });
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  return {
    merchantPubkey,
    postObservation: (body) => postSigned("/api/v1/observations", body),
    getStats: async (q) => {
      const qs = q
        ? "?" +
          Object.entries(q)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&")
        : "";
      return getJson(`/api/v1/merchants/me/stats${qs}`);
    },
    getMerchants: () => getJson("/api/v1/merchants"),
    postRegister: async (body) => {
      const r = await postSigned("/api/v1/endpoint/register", body);
      return r.body;
    },
  };
}
