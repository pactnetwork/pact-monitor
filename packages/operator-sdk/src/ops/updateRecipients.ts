import { PublicKey, Signer, TransactionInstruction } from "@solana/web3.js";
import {
  buildUpdateFeeRecipientsIx,
  FeeRecipient,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getTreasuryPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { smartSubmit, type SmartSubmitResult } from "../submit/smart-submit.js";
import type { OperatorConfig, SmartSubmitOptions } from "../config.js";

export interface UpdateFeeRecipientsParams {
  slug: string | Uint8Array;
  feeRecipients: FeeRecipient[];
  /** AffiliateAta token-account pubkeys in the same order as the
   * AffiliateAta entries in `feeRecipients`. */
  affiliateAtas?: PublicKey[];
}

export function buildUpdateFeeRecipientsIxs(
  config: OperatorConfig,
  authority: PublicKey,
  params: UpdateFeeRecipientsParams,
): { instructions: TransactionInstruction[]; writableAccounts: PublicKey[] } {
  const { programId } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [protocolConfig] = getProtocolConfigPda(programId);
  const [treasury] = getTreasuryPda(programId);
  const [endpointConfig] = getEndpointConfigPda(programId, slug);
  const ix = buildUpdateFeeRecipientsIx({
    programId,
    authority,
    protocolConfig,
    treasury,
    endpointConfig,
    slug,
    feeRecipients: params.feeRecipients,
    feeRecipientCount: params.feeRecipients.length,
    affiliateAtas: params.affiliateAtas,
  });
  return {
    instructions: [ix],
    writableAccounts: [endpointConfig],
  };
}

export async function submitUpdateFeeRecipients(
  config: OperatorConfig,
  authority: Signer,
  params: UpdateFeeRecipientsParams,
  opts?: SmartSubmitOptions,
): Promise<SmartSubmitResult> {
  const built = buildUpdateFeeRecipientsIxs(
    config,
    authority.publicKey,
    params,
  );
  return smartSubmit({
    connection: config.connection,
    instructions: built.instructions,
    signer: authority,
    priorityFeeAccounts: built.writableAccounts,
    options: { ...config.smartSubmit, ...opts },
  });
}
