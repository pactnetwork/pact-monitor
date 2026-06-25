/**
 * X-Pact-Proxied-By attestation helpers (spec §4, task I7).
 *
 * A merchant or proxy that observes a covered call signs a short attestation
 * that the agent SDK can verify to suppress its own record write. The
 * signature is over a sha256 of a domain-prefixed, newline-joined canonical
 * message. The domain prefix is mandatory: it prevents a signing oracle for
 * another Pact protocol message from producing a valid proxied-by signature.
 *
 * Pure module — no imports from the rest of the SDK so it can later be
 * extracted into a shared `@pact-network/core` without churn.
 */
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

export interface ProxiedByMessage {
  /** Base58 merchant (or proxy) pubkey that signs the attestation. */
  merchantPubkey: string;
  /** Base58 agent pubkey from the inbound X-Pact-Pubkey request header. */
  agentPubkey: string;
  /** Agent-supplied start timestamp in ms epoch (X-Pact-Started-At). */
  startedAt: number;
  /** Route path / endpoint key under which the call was billed. */
  endpoint: string;
  /** HTTP status code of the upstream response. */
  statusCode: number;
}

/** Domain prefix — bump when changing the canonical layout. */
export const PROXIED_BY_DOMAIN = "pact:proxied-by:v1";

/** Returns the 32-byte sha256 digest the attestation signs over. */
export function canonicalProxiedByMessage(m: ProxiedByMessage): Uint8Array {
  const text = [
    PROXIED_BY_DOMAIN,
    m.merchantPubkey,
    m.agentPubkey,
    String(m.startedAt),
    m.endpoint,
    String(m.statusCode),
  ].join("\n");
  return createHash("sha256").update(text, "utf8").digest();
}

/** Sign the canonical digest with an ed25519 64-byte secret key. */
export function signProxiedBy(
  m: ProxiedByMessage,
  secretKey: Uint8Array,
): string {
  const digest = canonicalProxiedByMessage(m);
  const sig = nacl.sign.detached(digest, secretKey);
  return Buffer.from(sig).toString("base64");
}

/**
 * Verify a base64-encoded signature against the canonical digest and a
 * base58-encoded pubkey. Returns false on any malformed input rather than
 * throwing — callers treat "did not verify" identically to "header absent".
 */
export function verifyProxiedBy(
  m: ProxiedByMessage,
  sigB64: string,
  merchantPubkeyB58: string,
): boolean {
  try {
    const sig = Buffer.from(sigB64, "base64");
    if (sig.length !== 64) return false;
    const pubkey = bs58.decode(merchantPubkeyB58);
    if (pubkey.length !== 32) return false;
    const digest = canonicalProxiedByMessage(m);
    return nacl.sign.detached.verify(digest, sig, pubkey);
  } catch {
    return false;
  }
}
