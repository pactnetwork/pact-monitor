import { InvalidArgumentError } from "commander";

// v0.1.0 ships devnet-only. Mainnet is gated to the Friday harden pass.
// Both --cluster and PACT_CLUSTER flow through this validator so mainnet is
// rejected before any wallet, RPC, or signing side effects (B2).
export function validateClusterStrict(value: string): "devnet" {
  if (value !== "devnet") {
    throw new InvalidArgumentError(
      `--cluster ${value} not supported in v0.1.0; only 'devnet' is allowed (mainnet gated to Friday harden)`,
    );
  }
  return "devnet";
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
