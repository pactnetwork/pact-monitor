/**
 * Signer abstraction.
 *
 * Two concerns, deliberately separated:
 *
 *  1. On-chain ops (`setup`/`topUp`/`revoke`) need to sign a Solana
 *     transaction. A `Keypair` or a wallet-adapter-shaped object works.
 *  2. Proxy request auth needs a raw ed25519 signature over a byte payload
 *     (see proxy-transport). The Pact Market proxy verifies a **bs58**
 *     `nacl.sign.detached` signature (verify-signature.ts). Only a `Keypair`
 *     (or an explicit `secretKey`) exposes the raw secret needed for this —
 *     wallet adapters cannot produce a detached message signature, so a
 *     wallet-adapter integration must supply `secretKey` if it wants covered
 *     (signed) proxy calls; otherwise those calls degrade to bare fetch.
 *
 * V1's primary target is server-side agents holding a hot `Keypair`.
 * `@solana/kit` is intentionally NOT supported to avoid a second, conflicting
 * Solana library tree — `@solana/web3.js` 1.x is the only Solana runtime dep
 * (matches `@pact-network/protocol-v1-client` and `@q3labs/pact-cli`).
 */
import type { Keypair, Transaction } from "@solana/web3.js";

export interface WalletAdapterSigner {
  publicKey: { toBase58(): string; toBuffer(): Buffer };
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export type PactSigner = Keypair | WalletAdapterSigner;

export function isKeypair(s: PactSigner): s is Keypair {
  return (
    typeof (s as Keypair).secretKey === "object" &&
    (s as Keypair).secretKey instanceof Uint8Array
  );
}

export function signerPublicKey(s: PactSigner): string {
  return s.publicKey.toBase58();
}

/**
 * Resolve the 64-byte ed25519 secret key used for proxy request signing.
 * Returns null when the signer cannot expose it (wallet adapter without an
 * explicit secretKey override) — callers must then route bare (degraded).
 */
export function resolveSecretKey(
  s: PactSigner,
  override?: Uint8Array,
): Uint8Array | null {
  if (override) return override;
  if (isKeypair(s)) return s.secretKey;
  return null;
}
