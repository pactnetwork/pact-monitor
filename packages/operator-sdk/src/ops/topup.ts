import { PublicKey, Signer, TransactionInstruction } from "@solana/web3.js";
import {
  buildTopUpCoveragePoolIx,
  decodeCoveragePool,
  getCoveragePoolPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { OperatorError, OperatorErrorCode } from "../errors.js";
import { smartSubmit, type SmartSubmitResult } from "../submit/smart-submit.js";
import type { OperatorConfig, SmartSubmitOptions } from "../config.js";

export interface TopUpCoveragePoolParams {
  slug: string | Uint8Array;
  /** Amount in USDC base units (6 decimals). */
  amount: bigint;
  /** Source SPL Token account (the pool authority's USDC ATA). */
  authorityAta: PublicKey;
  /** Destination pool vault — pre-allocated at register time. */
  poolVault: PublicKey;
}

export function buildTopUpCoveragePoolIxs(
  config: OperatorConfig,
  authority: PublicKey,
  params: TopUpCoveragePoolParams,
): { instructions: TransactionInstruction[]; writableAccounts: PublicKey[] } {
  const { programId } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [coveragePool] = getCoveragePoolPda(programId, slug);
  const ix = buildTopUpCoveragePoolIx({
    programId,
    authority,
    coveragePool,
    authorityAta: params.authorityAta,
    poolVault: params.poolVault,
    slug,
    amount: params.amount,
  });
  return {
    instructions: [ix],
    writableAccounts: [coveragePool, params.authorityAta, params.poolVault],
  };
}

/**
 * Convenience submitter. Pre-flights `CoveragePool.authority == signer.publicKey`
 * (NOT ProtocolConfig.authority — topup is the one op that uses a per-pool
 * authority; see `pact-network-v1-pinocchio/src/instructions/top_up_coverage_pool.rs:68`).
 * Throws `OperatorError.POOL_AUTHORITY_MISMATCH` with both pubkeys in
 * `details` so the caller can route to the right signer.
 */
export async function submitTopUpCoveragePool(
  config: OperatorConfig,
  poolAuthority: Signer,
  params: TopUpCoveragePoolParams,
  opts?: SmartSubmitOptions,
): Promise<SmartSubmitResult> {
  const { connection, programId } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [coveragePool] = getCoveragePoolPda(programId, slug);

  const info = await connection.getAccountInfo(coveragePool, "confirmed");
  if (!info) {
    throw new OperatorError(
      OperatorErrorCode.ENDPOINT_NOT_REGISTERED,
      `coverage pool ${coveragePool.toBase58()} not found — slug not registered`,
      { details: { coveragePool: coveragePool.toBase58() } },
    );
  }
  const pool = decodeCoveragePool(info.data);
  const onChainAuthority = new PublicKey(pool.authority as never);
  if (!onChainAuthority.equals(poolAuthority.publicKey)) {
    throw new OperatorError(
      OperatorErrorCode.POOL_AUTHORITY_MISMATCH,
      `topup signer ${poolAuthority.publicKey.toBase58()} != CoveragePool.authority ${onChainAuthority.toBase58()}`,
      {
        details: {
          expected: onChainAuthority.toBase58(),
          actual: poolAuthority.publicKey.toBase58(),
        },
      },
    );
  }

  const built = buildTopUpCoveragePoolIxs(
    config,
    poolAuthority.publicKey,
    params,
  );
  return smartSubmit({
    connection,
    instructions: built.instructions,
    signer: poolAuthority,
    priorityFeeAccounts: built.writableAccounts,
    options: { ...config.smartSubmit, ...opts },
  });
}
