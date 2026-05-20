import { PublicKey, Signer, TransactionInstruction } from "@solana/web3.js";
import {
  buildPauseEndpointIx,
  getEndpointConfigPda,
  getProtocolConfigPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { smartSubmit, type SmartSubmitResult } from "../submit/smart-submit.js";
import type { OperatorConfig, SmartSubmitOptions } from "../config.js";

export interface PauseEndpointParams {
  slug: string | Uint8Array;
  paused: boolean;
}

export function buildPauseEndpointIxs(
  config: OperatorConfig,
  authority: PublicKey,
  params: PauseEndpointParams,
): { instructions: TransactionInstruction[]; writableAccounts: PublicKey[] } {
  const { programId } = config;
  const slug =
    typeof params.slug === "string" ? slugBytes(params.slug) : params.slug;
  const [protocolConfig] = getProtocolConfigPda(programId);
  const [endpointConfig] = getEndpointConfigPda(programId, slug);
  const ix = buildPauseEndpointIx({
    programId,
    authority,
    protocolConfig,
    endpointConfig,
    paused: params.paused,
  });
  return {
    instructions: [ix],
    writableAccounts: [endpointConfig],
  };
}

export async function submitPauseEndpoint(
  config: OperatorConfig,
  authority: Signer,
  params: PauseEndpointParams,
  opts?: SmartSubmitOptions,
): Promise<SmartSubmitResult> {
  const built = buildPauseEndpointIxs(config, authority.publicKey, params);
  return smartSubmit({
    connection: config.connection,
    instructions: built.instructions,
    signer: authority,
    priorityFeeAccounts: built.writableAccounts,
    options: { ...config.smartSubmit, ...opts },
  });
}
