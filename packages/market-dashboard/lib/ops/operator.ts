import type { Connection } from "@solana/web3.js";
import {
  createOperator,
  type OperatorInstance,
} from "@q3labs/pact-operator-sdk";
import {
  PROGRAM_ID,
  PROGRAM_ID_DEVNET,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "@q3labs/pact-protocol-v1-client";

/**
 * Cluster to target for operator ops. Defaults to devnet — the dashboard
 * ops console is a devnet-first surface (the broken-settlement devnet
 * deploy notwithstanding; operator instructions work on it). Set
 * NEXT_PUBLIC_PACT_CLUSTER=mainnet to flip.
 */
export type Cluster = "mainnet" | "devnet";

export const CLUSTER: Cluster =
  (process.env.NEXT_PUBLIC_PACT_CLUSTER as Cluster | undefined) ?? "devnet";

export const PROGRAM = CLUSTER === "mainnet" ? PROGRAM_ID : PROGRAM_ID_DEVNET;
export const MINT = CLUSTER === "mainnet" ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;

/**
 * Build an `OperatorInstance` for the connected RPC. The SDK is pure ESM +
 * `@solana/web3.js`; safe in the browser. The `submitX` helpers are NOT
 * used from the dashboard (they require a `Signer.secretKey` which
 * wallet-adapter does not expose) — only `build.*` and
 * `getProtocolAuthority()` are consumed.
 */
export function getOperator(connection: Connection): OperatorInstance {
  return createOperator({
    connection,
    programId: PROGRAM,
    usdcMint: MINT,
  });
}
