/**
 * Signer abstraction.
 *
 * Two concerns, deliberately separated:
 *
 *  1. On-chain ops (Solana `setup`/`topUp`/`revoke`) need to sign a Solana
 *     transaction. A `Keypair` or a wallet-adapter-shaped object works. EVM
 *     signers are not valid for these ops (no Solana program ID applies).
 *  2. Proxy request auth needs a raw signature over a byte payload. The Pact
 *     Market proxy verifies one of two primitives:
 *       - Solana: bs58-encoded Ed25519 (`nacl.sign.detached`)
 *       - EVM: 0x-hex secp256k1 / EIP-191 (`viem.signMessage`)
 *     The transport calls `signer.sign(payload)` opaquely; the signer module
 *     formats the resulting bytes per VM (bs58 vs 0x-hex) and picks the right
 *     `x-pact-agent` shape (bs58 pubkey vs EIP-55 0x address).
 *
 * V1's primary target is server-side agents holding a hot signer. Wallet
 * adapters cannot produce a detached message signature, so a wallet-adapter
 * integration must supply `requestSigningSecretKey` if it wants covered
 * (signed) proxy calls; otherwise those calls degrade to bare fetch.
 */
import type { Keypair, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { getAddress, isAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface WalletAdapterSigner {
  publicKey: { toBase58(): string; toBuffer(): Buffer };
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export type SolanaPactSigner = Keypair | WalletAdapterSigner;

/**
 * EVM secp256k1 signer. The address is the agent identity; `privateKey` is the
 * 0x-prefixed 32-byte secret used for EIP-191 personal_sign. Either supply
 * `privateKey` on the signer or pass it via `requestSigningSecretKey` on
 * `PactConfig` — when neither is present, covered calls degrade to bare fetch
 * (matches the Solana wallet-adapter-without-secret degrade contract).
 */
export interface EvmPactSigner {
  kind: "evm";
  address: `0x${string}`;
  privateKey?: `0x${string}`;
}

export type PactSigner = SolanaPactSigner | EvmPactSigner;

export type Vm = "solana" | "evm";

/** Sign a raw payload. Returns Solana 64-byte bytes or EVM 0x-hex (65 bytes). */
export type SignFn = (payload: Uint8Array) => Promise<Uint8Array | `0x${string}`>;

export function isEvmSigner(s: PactSigner): s is EvmPactSigner {
  return (
    s != null &&
    typeof s === "object" &&
    (s as { kind?: unknown }).kind === "evm"
  );
}

export function isKeypair(s: unknown): s is Keypair {
  if (s == null || typeof s !== "object") return false;
  if ((s as { kind?: unknown }).kind === "evm") return false;
  const sk = (s as { secretKey?: unknown }).secretKey;
  if (sk == null || typeof sk !== "object") return false;
  // Cross-realm-safe: `instanceof Uint8Array` returns false when the caller
  // and the SDK have different module copies of @solana/web3.js loaded — the
  // secretKey is then a Uint8Array from a different constructor identity.
  // `ArrayBuffer.isView` checks the internal slot and is realm-agnostic.
  if (!ArrayBuffer.isView(sk)) return false;
  const length = (sk as { length?: unknown }).length;
  return typeof length === "number" && length === 64;
}

export function signerVm(s: PactSigner): Vm {
  return isEvmSigner(s) ? "evm" : "solana";
}

/**
 * Agent identity for the `x-pact-agent` header:
 *  - Solana: bs58-encoded ed25519 public key
 *  - EVM: EIP-55 checksummed 0x address
 */
export function signerAddress(s: PactSigner): string {
  if (isEvmSigner(s)) return getAddress(s.address);
  return (s as SolanaPactSigner).publicKey.toBase58();
}

/** Solana-only: returns the bs58 pubkey. Throws for EVM signers. */
export function signerPublicKey(s: PactSigner): string {
  if (isEvmSigner(s)) {
    throw new Error("signerPublicKey: EVM signer has no Solana publicKey");
  }
  return (s as SolanaPactSigner).publicKey.toBase58();
}

/**
 * Resolve a signing function for proxy request auth. Returns null when the
 * signer cannot expose a raw secret (Solana wallet adapter with no override,
 * or EVM signer with no privateKey + no override) — callers must then route
 * bare (degraded).
 *
 * The override widens to `Uint8Array | 0x-hex string`: a Uint8Array is treated
 * as a 64-byte ed25519 secret for Solana; a 0x-hex string is treated as a
 * 32-byte secp256k1 private key for EVM.
 */
export function resolveSignFn(
  s: PactSigner,
  override?: Uint8Array | `0x${string}`,
): SignFn | null {
  if (isEvmSigner(s)) {
    const pk: `0x${string}` | undefined =
      typeof override === "string" && isHex(override)
        ? (override as `0x${string}`)
        : s.privateKey;
    if (!pk) return null;
    let account;
    try {
      account = privateKeyToAccount(pk);
    } catch {
      return null;
    }
    return async (payload) =>
      account.signMessage({ message: { raw: payload } });
  }
  // Solana path
  let secret: Uint8Array | null = null;
  if (override != null && ArrayBuffer.isView(override)) {
    secret = override as Uint8Array;
  } else if (isKeypair(s)) {
    secret = (s as Keypair).secretKey;
  }
  if (!secret || secret.length !== 64) return null;
  const sk = secret;
  return async (payload) => nacl.sign.detached(payload, sk);
}

/** Validate an EVM private key derives the claimed address (EIP-55 normalised). */
export function evmAddressFromPrivateKey(
  pk: `0x${string}`,
): `0x${string}` | null {
  try {
    return privateKeyToAccount(pk).address;
  } catch {
    return null;
  }
}

/**
 * Solana-only: extract raw 64-byte secret key from a keypair signer.
 * Returns null for wallet adapters (no exposed secret) and EVM signers.
 * Used by the merchant SDK for nacl observation-body signing — distinct
 * from resolveSignFn which returns an async SignFn for proxy transport.
 */
export function resolveSecretKey(s: PactSigner): Uint8Array | null {
  if (isEvmSigner(s)) return null;
  if (isKeypair(s)) return (s as Keypair).secretKey;
  return null;
}

/** Re-export viem helpers callers may need for type narrowing on hex strings. */
export { isAddress, isHex };
