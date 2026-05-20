import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  type Signer,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { SendTransactionOptions } from "@solana/wallet-adapter-base";

/**
 * Minimal wallet-adapter shape we depend on. Matches `useWallet()` return.
 */
export interface WalletLike {
  publicKey: PublicKey | null;
  sendTransaction: (
    tx: Transaction,
    connection: Connection,
    options?: SendTransactionOptions,
  ) => Promise<string>;
}

export interface SubmitOpsArgs {
  connection: Connection;
  wallet: WalletLike;
  instructions: TransactionInstruction[];
  /** Writable accounts for `getRecentPrioritizationFees` biasing. */
  priorityFeeAccounts?: PublicKey[];
  /** Extra signers (e.g., register's throwaway poolVault keypair). */
  extraSigners?: Signer[];
  /**
   * Smart-submit-style tuning. Defaults are conservative and match the
   * operator-sdk's smartSubmit semantics.
   */
  priorityFeePercentile?: number;
  priorityFeeFallback?: number;
  computeUnitLimit?: number;
}

export type SubmitOpsResult =
  | { ok: true; signature: string; blockhash: string; lastValidBlockHeight: number }
  | { ok: false; error: string };

const DEFAULTS = {
  priorityFeePercentile: 75,
  priorityFeeFallback: 1000,
  computeUnitLimit: 200_000,
};

/**
 * Build + send a Pact operator tx through the connected wallet. Multi-signer
 * flow per the wallet-adapter docs: `tx.partialSign(extraSigners)` BEFORE
 * `wallet.sendTransaction(tx, connection)`. Confirms via
 * `connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight })`
 * which honors the blockhash expiry (vs polling getSignatureStatus
 * indefinitely).
 *
 * NOT used: the operator-sdk's `submitX` helpers require `Signer.secretKey`,
 * which `useWallet()` does not expose. We re-implement the priority-fee + CU
 * budget shape here so the dashboard's tx UX is consistent with the CLI's
 * but doesn't need a secret key.
 */
export async function submitOps(args: SubmitOpsArgs): Promise<SubmitOpsResult> {
  const { connection, wallet, instructions } = args;
  if (!wallet.publicKey) {
    return { ok: false, error: "wallet not connected" };
  }
  try {
    const microLamportsPerCu = await estimatePriorityFee(
      connection,
      args.priorityFeeAccounts ?? [],
      args.priorityFeePercentile ?? DEFAULTS.priorityFeePercentile,
      args.priorityFeeFallback ?? DEFAULTS.priorityFeeFallback,
    );
    const computeBudgetIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: args.computeUnitLimit ?? DEFAULTS.computeUnitLimit,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: microLamportsPerCu,
      }),
    ];

    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(...computeBudgetIxs, ...instructions);

    if (args.extraSigners && args.extraSigners.length > 0) {
      tx.partialSign(...args.extraSigners);
    }

    const signature = await wallet.sendTransaction(tx, connection);
    const confirm = await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirm.value.err) {
      return {
        ok: false,
        error: `tx ${signature} failed: ${JSON.stringify(confirm.value.err)}`,
      };
    }
    return {
      ok: true,
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function estimatePriorityFee(
  connection: Connection,
  accounts: PublicKey[],
  percentile: number,
  fallback: number,
): Promise<number> {
  try {
    const samples = await connection.getRecentPrioritizationFees(
      accounts.length > 0 ? { lockedWritableAccounts: accounts } : undefined,
    );
    if (samples.length === 0) return fallback;
    const fees = samples.map((s) => s.prioritizationFee).sort((a, b) => a - b);
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

/** Solana Explorer link helper (devnet by default; mainnet if env says so). */
export function explorerTxUrl(signature: string): string {
  const cluster =
    (process.env.NEXT_PUBLIC_PACT_CLUSTER as string | undefined) ?? "devnet";
  const suffix = cluster === "mainnet" ? "" : "?cluster=devnet";
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}
