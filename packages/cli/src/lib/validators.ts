import { InvalidArgumentError } from "commander";

// Tonight's mainnet launch ships closed-beta access. Mainnet is gated behind
// PACT_MAINNET_ENABLED=1 so a default build cannot accidentally route real
// USDC through the production program. devnet stays open. validators below
// short-circuit invalid input to a `client_error` envelope before any RPC
// or signing side effect.
export function validateClusterStrict(value: string): "devnet" | "mainnet" {
  if (value === "devnet") return "devnet";
  if (value === "mainnet") {
    if (process.env.PACT_MAINNET_ENABLED !== "1") {
      throw new InvalidArgumentError(
        "--cluster mainnet requires PACT_MAINNET_ENABLED=1 (closed beta gate)",
      );
    }
    return "mainnet";
  }
  throw new InvalidArgumentError(
    `--cluster ${value} not supported; choose 'devnet' or 'mainnet'`,
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
