import { InvalidArgumentError } from "commander";
import { PublicKey } from "@solana/web3.js";

// Cluster validator. Mainnet stays gated behind PACT_MAINNET_ENABLED=1 so
// a default build can't accidentally route real USDC through the production
// program. Devnet is unblocked for operator-sdk ops (register / config /
// pause / topup / earnings) — those instructions work on the devnet deploy
// `5jBQb7fL…`. `settle_batch` reverts InvalidSeeds on devnet due to a
// `declare_id!` mismatch in the binary, so settlement-dependent flows are
// independently blocked at the SDK layer.
export function validateClusterStrict(value: string): "mainnet" | "devnet" {
  if (value === "mainnet") {
    if (process.env.PACT_MAINNET_ENABLED !== "1") {
      throw new InvalidArgumentError(
        "--cluster mainnet requires PACT_MAINNET_ENABLED=1 (closed beta gate)",
      );
    }
    return "mainnet";
  }
  if (value === "devnet") {
    return "devnet";
  }
  throw new InvalidArgumentError(
    `--cluster ${value} not supported; choose 'mainnet' (gated) or 'devnet'`,
  );
}

// Commander coercer: accept only finite, strictly-positive floats. Rejects
// NaN, Infinity, negatives, zero, and non-numeric strings so a stack trace
// can't leak out of the action handler when garbage is passed (H4).
export function parsePositiveFloat(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(
      `expected a finite number greater than 0, got '${value}'`,
    );
  }
  return n;
}

// Commander coercer: accept only finite, strictly-positive integers. Same
// rationale as parsePositiveFloat — keeps invalid input on the client_error
// path instead of cli_internal_error (H4).
export function parsePositiveInt(value: string): number {
  // Reject decimals up front so '1.5' doesn't silently truncate to 1.
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      `expected a positive integer, got '${value}'`,
    );
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(
      `expected a positive integer, got '${value}'`,
    );
  }
  return n;
}

// Commander coercer: validate URL parses with WHATWG URL. Rejects bare
// hostnames and malformed input early so `pact <garbage>` never reaches
// the runCommand path where new URL() would throw and leak a stack trace
// through the top-level catch (H4).
export function parseUrlStrict(value: string): string {
  try {
    new URL(value);
  } catch {
    throw new InvalidArgumentError(
      `expected an absolute URL (e.g. https://example.com/path), got '${value}'`,
    );
  }
  return value;
}

// Commander coercer: validate a Solana base58 PublicKey at parse time. A bad
// pubkey inside an action handler would otherwise throw and exit 99
// `cli_internal_error`; routing it through Commander's coercer makes it a
// clean `client_error` with a short message (Solana-cli style).
export function parsePubkeyStrict(value: string): string {
  try {
    new PublicKey(value);
  } catch {
    throw new InvalidArgumentError(
      `expected a Solana base58 pubkey (32-byte), got '${value}'`,
    );
  }
  return value;
}

// Commander coercer: accept "true" / "false" / "1" / "0" booleans. Used for
// optional flags that can be unset (Commander's bare --flag is a different
// shape; this is for explicit "--paused true" form when a default exists).
export function parseBoolStrict(value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new InvalidArgumentError(
    `expected 'true' or 'false', got '${value}'`,
  );
}
