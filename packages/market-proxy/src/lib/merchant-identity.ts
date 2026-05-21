/**
 * Proxy merchant identity for the X-Pact-Proxied-By attestation protocol
 * (Commit 2 D.1).
 *
 * Loaded lazily on first read so a test harness can swap the env between
 * proxy reloads without re-importing. The ProxyMerchantIdentity is also
 * the identity ops must mirror in api_keys with role='merchant' so the
 * agent SDK's E5 registry surface picks it up.
 */
import bs58 from "bs58";
import nacl from "tweetnacl";

export interface ProxyMerchantIdentity {
  publicKeyB58: string;
  secretKey: Uint8Array;
}

let cached: ProxyMerchantIdentity | null | undefined = undefined;
let warned = false;

function decodeSecretKey(raw: string): Uint8Array | null {
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed) as number[];
      if (!Array.isArray(arr) || arr.length !== 64) return null;
      return Uint8Array.from(arr);
    }
    const bytes = bs58.decode(trimmed);
    if (bytes.length !== 64) return null;
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Returns the proxy's merchant identity, or null when none is configured.
 * Caches the result so subsequent reads are O(1).
 *
 * Logs ONCE on first read when missing so we don't spam at request rate.
 */
export function getProxyMerchantIdentity(): ProxyMerchantIdentity | null {
  if (cached !== undefined) return cached;
  const raw = process.env.PACT_PROXY_MERCHANT_SECRET_KEY;
  if (!raw) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        "PACT_PROXY_MERCHANT_SECRET_KEY unset — proxy will NOT stamp " +
          "X-Pact-Proxied-By attestations. Agent SDKs will record locally; " +
          "the DB unique index keeps premiums idempotent.",
      );
      warned = true;
    }
    cached = null;
    return null;
  }
  const sk = decodeSecretKey(raw);
  if (!sk) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        "PACT_PROXY_MERCHANT_SECRET_KEY is malformed (expected base58 or " +
          "JSON array of 64 bytes). Attestation disabled.",
      );
      warned = true;
    }
    cached = null;
    return null;
  }
  const pk = nacl.sign.keyPair.fromSecretKey(sk).publicKey;
  cached = { publicKeyB58: bs58.encode(pk), secretKey: sk };
  return cached;
}

/** Test helper: clear the cache so a subsequent read re-evaluates env. */
export function __resetProxyMerchantIdentityForTests(): void {
  cached = undefined;
  warned = false;
}
