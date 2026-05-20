import type { Connection, PublicKey } from "@solana/web3.js";

/**
 * Smart-submit tuning. All fields optional; defaults match Helius
 * `sendSmartTransaction` semantics (simulate-first, priority fee from
 * `getRecentPrioritizationFees` percentile, CU budget, blockheight-bounded
 * retry).
 */
export interface SmartSubmitOptions {
  /**
   * Percentile of recent prioritization fees to use as the compute unit
   * price (0..100). Default 75 — middle of the contended pack.
   */
  priorityFeePercentile?: number;
  /**
   * If RPC returns no recent prioritization fees, fall back to this many
   * micro-lamports per CU. Default 1000.
   */
  priorityFeeFallback?: number;
  /**
   * Compute unit limit. Default 200_000 (ops are small; register is the
   * largest at ~80k).
   */
  computeUnitLimit?: number;
  /**
   * If true (default), simulate before sending. A failing simulation throws
   * `OperatorError.SIMULATION_FAILED` and never sends — saves fees on
   * authority/state mismatches.
   */
  simulateFirst?: boolean;
  /**
   * Max poll interval between confirmation checks, in ms. Default 1500.
   */
  pollIntervalMs?: number;
}

export interface OperatorConfig {
  /** web3.js Connection — the operator owns transport. */
  connection: Connection;
  /**
   * V1 program ID. REQUIRED — no default. On devnet, `5jBQb7fL…` reads but
   * cannot settle (declare_id mismatch); on mainnet, `5bCJcdWdK…`.
   * (`@q3labs/pact-protocol-v1-client` exports `PROGRAM_ID` and
   * `PROGRAM_ID_DEVNET` for the canonical values.)
   */
  programId: PublicKey;
  /**
   * USDC mint on the operator's network. Used for pool-vault / fee-recipient
   * ATA derivation in builders that need it (register, topup,
   * updateFeeRecipients). REQUIRED.
   */
  usdcMint: PublicKey;
  /** Default smart-submit tuning applied to every submit*. */
  smartSubmit?: SmartSubmitOptions;
}
