import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { OperatorError, OperatorErrorCode } from "../errors.js";
import type { SmartSubmitOptions } from "../config.js";

const DEFAULTS = {
  priorityFeePercentile: 75,
  priorityFeeFallback: 1000,
  computeUnitLimit: 200_000,
  simulateFirst: true,
  pollIntervalMs: 1500,
} satisfies Required<SmartSubmitOptions>;

export interface SmartSubmitArgs {
  connection: Connection;
  instructions: TransactionInstruction[];
  signer: Signer;
  /**
   * Writable accounts to bias `getRecentPrioritizationFees` toward the lanes
   * this tx actually touches. Without this the RPC returns a global sample
   * which over- or under-estimates fees. Pass the writable PDAs/ATAs of
   * the op (e.g., CoveragePool + pool vault for topup).
   */
  priorityFeeAccounts?: PublicKey[];
  /** Extra signers (rare for ops; e.g., a fresh keypair for a new account). */
  additionalSigners?: Signer[];
  options?: SmartSubmitOptions;
}

export interface SmartSubmitResult {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  computeUnitsConsumed?: number;
}

/**
 * Build → (optionally simulate) → prepend ComputeBudget(price+limit) → sign →
 * send → poll until `lastValidBlockHeight` elapses. Returns the signature on
 * first confirmation. Throws `OperatorError.SIMULATION_FAILED` if simulation
 * fails (no send), `BLOCK_HEIGHT_EXCEEDED` if the blockhash expires, or
 * `RPC_ERROR` on any other RPC failure.
 *
 * Reference: Helius `sendSmartTransaction` semantics; production-grade
 * Solana tx submission requires all four (priority fee, CU limit,
 * simulate-first, blockheight-bounded retry).
 */
export async function smartSubmit(
  args: SmartSubmitArgs,
): Promise<SmartSubmitResult> {
  const o = { ...DEFAULTS, ...(args.options ?? {}) };
  const { connection, signer } = args;

  const microLamportsPerCu = await estimatePriorityFee(
    connection,
    args.priorityFeeAccounts ?? [],
    o.priorityFeePercentile,
    o.priorityFeeFallback,
  );

  const computeBudgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamportsPerCu,
    }),
  ];

  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    blockhash = latest.blockhash;
    lastValidBlockHeight = latest.lastValidBlockHeight;
  } catch (cause) {
    throw new OperatorError(
      OperatorErrorCode.RPC_ERROR,
      "failed to fetch latest blockhash",
      { cause },
    );
  }

  const tx = new Transaction({
    feePayer: signer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...computeBudgetIxs, ...args.instructions);

  const allSigners = [signer, ...(args.additionalSigners ?? [])];
  tx.sign(...allSigners);

  let computeUnitsConsumed: number | undefined;
  if (o.simulateFirst) {
    try {
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        throw new OperatorError(
          OperatorErrorCode.SIMULATION_FAILED,
          `simulation failed: ${JSON.stringify(sim.value.err)}`,
          { details: { err: sim.value.err, logs: sim.value.logs ?? [] } },
        );
      }
      computeUnitsConsumed = sim.value.unitsConsumed;
    } catch (cause) {
      if (cause instanceof OperatorError) throw cause;
      throw new OperatorError(
        OperatorErrorCode.RPC_ERROR,
        "simulation RPC failed",
        { cause },
      );
    }
  }

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, // we already simulated when configured to
      maxRetries: 0,
    });
  } catch (cause) {
    throw new OperatorError(
      OperatorErrorCode.RPC_ERROR,
      "sendRawTransaction failed",
      { cause },
    );
  }

  await confirmWithBlockHeight(
    connection,
    signature,
    lastValidBlockHeight,
    o.pollIntervalMs,
  );

  return { signature, blockhash, lastValidBlockHeight, computeUnitsConsumed };
}

async function estimatePriorityFee(
  connection: Connection,
  accounts: PublicKey[],
  percentile: number,
  fallback: number,
): Promise<number> {
  try {
    const samples = await connection.getRecentPrioritizationFees(
      accounts.length > 0
        ? { lockedWritableAccounts: accounts }
        : undefined,
    );
    if (samples.length === 0) return fallback;
    const fees = samples
      .map((s) => s.prioritizationFee)
      .sort((a, b) => a - b);
    const idx = Math.min(
      fees.length - 1,
      Math.floor((fees.length * percentile) / 100),
    );
    const v = fees[idx];
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

async function confirmWithBlockHeight(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  pollIntervalMs: number,
): Promise<void> {
  for (;;) {
    let status;
    try {
      status = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: false,
      });
    } catch (cause) {
      throw new OperatorError(
        OperatorErrorCode.RPC_ERROR,
        "getSignatureStatus failed",
        { cause },
      );
    }
    const v = status.value;
    if (v) {
      if (v.err) {
        throw new OperatorError(
          OperatorErrorCode.RPC_ERROR,
          `tx ${signature} failed on-chain: ${JSON.stringify(v.err)}`,
          { details: { err: v.err, signature } },
        );
      }
      if (
        v.confirmationStatus === "confirmed" ||
        v.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    let currentBlockHeight: number;
    try {
      currentBlockHeight = await connection.getBlockHeight("confirmed");
    } catch (cause) {
      throw new OperatorError(
        OperatorErrorCode.RPC_ERROR,
        "getBlockHeight failed",
        { cause },
      );
    }
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new OperatorError(
        OperatorErrorCode.BLOCK_HEIGHT_EXCEEDED,
        `tx ${signature} not confirmed before lastValidBlockHeight ${lastValidBlockHeight} (current ${currentBlockHeight})`,
        { details: { signature, lastValidBlockHeight, currentBlockHeight } },
      );
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
