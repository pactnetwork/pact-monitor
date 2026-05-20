import { PublicKey, Signer, TransactionInstruction } from "@solana/web3.js";
import {
  buildUpdateEndpointConfigIx,
  getEndpointConfigPda,
  getProtocolConfigPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { smartSubmit, type SmartSubmitResult } from "../submit/smart-submit.js";
import type { OperatorConfig, SmartSubmitOptions } from "../config.js";

export interface UpdateEndpointConfigParams {
  slug: string | Uint8Array;
  flatPremiumLamports?: bigint;
  percentBps?: number;
  slaLatencyMs?: number;
  imputedCostLamports?: bigint;
  exposureCapPerHourLamports?: bigint;
}

export function buildUpdateEndpointConfigIxs(
  config: OperatorConfig,
  authority: PublicKey,
  params: UpdateEndpointConfigParams,
): { instructions: TransactionInstruction[]; writableAccounts: PublicKey[] } {
  const { programId } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [protocolConfig] = getProtocolConfigPda(programId);
  const [endpointConfig] = getEndpointConfigPda(programId, slug);
  const ix = buildUpdateEndpointConfigIx({
    programId,
    authority,
    protocolConfig,
    endpointConfig,
    flatPremiumLamports: params.flatPremiumLamports,
    percentBps: params.percentBps,
    slaLatencyMs: params.slaLatencyMs,
    imputedCostLamports: params.imputedCostLamports,
    exposureCapPerHourLamports: params.exposureCapPerHourLamports,
  });
  return {
    instructions: [ix],
    writableAccounts: [endpointConfig],
  };
}

export async function submitUpdateEndpointConfig(
  config: OperatorConfig,
  authority: Signer,
  params: UpdateEndpointConfigParams,
  opts?: SmartSubmitOptions,
): Promise<SmartSubmitResult> {
  const built = buildUpdateEndpointConfigIxs(
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
