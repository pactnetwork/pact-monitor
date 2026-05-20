import { Keypair } from "@solana/web3.js";
import { parseSecretKeyInput } from "./wallet.ts";

/**
 * Load the protocol-authority keypair from PACT_PRIVATE_KEY env (base58 secret
 * key, JSON byte-array, or file path — all handled by parseSecretKeyInput).
 *
 * Admin-only contract: NO disk-wallet fallback, NO key generation. The CLI's
 * generic wallet loader (lib/wallet.ts) is for agent keypairs that can be
 * auto-provisioned; admin signers must come from PACT_PRIVATE_KEY explicitly
 * so commands are only invokable from a box that has the authority secret.
 *
 * Returns `{ error }` instead of throwing so commands can surface a
 * structured envelope (client_error) instead of a stack trace.
 */
export function loadAuthorityKeypair(opts?: {
  /** Override env var name. Default PACT_PRIVATE_KEY. */
  envVar?: string;
  /** Command name surfaced in the error message. Default "this command". */
  commandLabel?: string;
}): Keypair | { error: string } {
  const envVar = opts?.envVar ?? "PACT_PRIVATE_KEY";
  const label = opts?.commandLabel ?? "this command";
  const raw = process.env[envVar];
  if (!raw) {
    return {
      error: `${label} requires ${envVar} env var holding the authority secret key (base58, JSON byte array, or path)`,
    };
  }
  let secret: Uint8Array;
  try {
    secret = parseSecretKeyInput(raw);
  } catch (err) {
    return { error: (err as Error).message };
  }
  return Keypair.fromSecretKey(secret);
}
