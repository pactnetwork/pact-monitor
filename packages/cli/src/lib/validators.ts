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
