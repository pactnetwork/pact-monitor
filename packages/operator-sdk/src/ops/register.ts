import {
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  buildRegisterEndpointIx,
  FeeRecipient,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getTreasuryPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { OperatorError, OperatorErrorCode } from "../errors.js";
import { smartSubmit, type SmartSubmitResult } from "../submit/smart-submit.js";
import type { OperatorConfig, SmartSubmitOptions } from "../config.js";

/** SPL Token account size — fixed by `spl-token` ABI. */
const TOKEN_ACCOUNT_LEN = 165;
/** Hardcoded SPL Token program ID — avoids a peerDep on @solana/spl-token. */
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export interface RegisterEndpointParams {
  /** UTF-8 string, ≤16 bytes after encoding. Padded to 16 with NUL. */
  slug: string | Uint8Array;
  /** Per-call flat premium in USDC base units (6 decimals). */
  flatPremiumLamports: bigint;
  /** Percent premium in basis points (0..10000). */
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
  /** Optional explicit fee recipients. When omitted, the program uses
   * ProtocolConfig.default_fee_recipients. When provided, ALL entries
   * (including Treasury) are honored verbatim — see
   * `register_endpoint.rs:46-206`. */
  feeRecipients?: FeeRecipient[];
  /**
   * Pre-allocated USDC vault account for the new pool. The program calls
   * SystemProgram::createAccount with this pubkey then InitializeAccount3.
   * Caller MUST sign the tx with the corresponding keypair (see
   * `submitRegisterEndpoint`'s `poolVault: Keypair`).
   */
  poolVault: PublicKey;
  /** Optional AffiliateAta token-account pubkeys, ordered to match the
   * AffiliateAta entries in feeRecipients. */
  affiliateAtas?: PublicKey[];
}

export interface BuildRegisterEndpointResult {
  instructions: TransactionInstruction[];
  /** All writable accounts (for priority-fee biasing). */
  writableAccounts: PublicKey[];
  /** Lamports required for the pool vault account (rent-exempt token acct). */
  poolVaultRentLamports: number;
}

/**
 * Build the createAccount + register_endpoint instruction pair. Does NOT
 * fetch rent — that's a one-RPC call the caller can batch; `submitRegisterEndpoint`
 * does it inline. Returns the ixes; caller signs with [authority, poolVault].
 */
export function buildRegisterEndpointIxs(
  config: OperatorConfig,
  authority: PublicKey,
  params: RegisterEndpointParams,
  /** Rent-exempt lamports for the new SPL Token account. Caller's responsibility
   * to fetch via `connection.getMinimumBalanceForRentExemption(165)`. */
  poolVaultRentLamports: number,
): BuildRegisterEndpointResult {
  const { programId, usdcMint } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [protocolConfig] = getProtocolConfigPda(programId);
  const [treasury] = getTreasuryPda(programId);
  const [endpointConfig] = getEndpointConfigPda(programId, slug);
  const [coveragePool] = getCoveragePoolPda(programId, slug);

  const createIx = SystemProgram.createAccount({
    fromPubkey: authority,
    newAccountPubkey: params.poolVault,
    lamports: poolVaultRentLamports,
    space: TOKEN_ACCOUNT_LEN,
    programId: TOKEN_PROGRAM_ID,
  });

  const regIx = buildRegisterEndpointIx({
    programId,
    authority,
    protocolConfig,
    treasury,
    endpointConfig,
    coveragePool,
    poolVault: params.poolVault,
    usdcMint,
    slug,
    flatPremiumLamports: params.flatPremiumLamports,
    percentBps: params.percentBps,
    slaLatencyMs: params.slaLatencyMs,
    imputedCostLamports: params.imputedCostLamports,
    exposureCapPerHourLamports: params.exposureCapPerHourLamports,
    feeRecipients: params.feeRecipients,
    feeRecipientCount: params.feeRecipients?.length,
    affiliateAtas: params.affiliateAtas,
  });

  return {
    instructions: [createIx, regIx],
    writableAccounts: [authority, params.poolVault, endpointConfig, coveragePool],
    poolVaultRentLamports,
  };
}

/**
 * Convenience: fetch rent, build, submit with [authority, poolVault] signers.
 *
 * Pre-flight: queries the endpoint PDA; if it already exists, throws
 * `OperatorError.ENDPOINT_ALREADY_REGISTERED` (idempotent skip is the
 * caller's job — see `scripts/smoke-devnet.ts` for the fixed-slug pattern).
 */
export async function submitRegisterEndpoint(
  config: OperatorConfig,
  authority: Signer,
  poolVault: Signer,
  params: RegisterEndpointParams,
  opts?: SmartSubmitOptions,
): Promise<SmartSubmitResult> {
  const { connection, programId } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [endpointConfig] = getEndpointConfigPda(programId, slug);

  const existing = await connection.getAccountInfo(endpointConfig, "confirmed");
  if (existing) {
    throw new OperatorError(
      OperatorErrorCode.ENDPOINT_ALREADY_REGISTERED,
      `endpoint already registered at ${endpointConfig.toBase58()}`,
      { details: { endpointConfig: endpointConfig.toBase58() } },
    );
  }

  const rent = await connection.getMinimumBalanceForRentExemption(
    TOKEN_ACCOUNT_LEN,
  );

  const built = buildRegisterEndpointIxs(
    config,
    authority.publicKey,
    { ...params, poolVault: poolVault.publicKey },
    rent,
  );

  return smartSubmit({
    connection,
    instructions: built.instructions,
    signer: authority,
    additionalSigners: [poolVault],
    priorityFeeAccounts: built.writableAccounts,
    options: { ...config.smartSubmit, ...opts },
  });
}
