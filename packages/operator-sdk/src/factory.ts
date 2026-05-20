import {
  decodeProtocolConfig,
  getProtocolConfigPda,
} from "@q3labs/pact-protocol-v1-client";
import { PublicKey, type Signer } from "@solana/web3.js";
import type { OperatorConfig, SmartSubmitOptions } from "./config.js";
import { OperatorError, OperatorErrorCode } from "./errors.js";
import {
  buildPauseEndpointIxs,
  submitPauseEndpoint,
  type PauseEndpointParams,
} from "./ops/pauseEndpoint.js";
import {
  buildRegisterEndpointIxs,
  submitRegisterEndpoint,
  type RegisterEndpointParams,
} from "./ops/register.js";
import {
  buildTopUpCoveragePoolIxs,
  submitTopUpCoveragePool,
  type TopUpCoveragePoolParams,
} from "./ops/topup.js";
import {
  buildUpdateEndpointConfigIxs,
  submitUpdateEndpointConfig,
  type UpdateEndpointConfigParams,
} from "./ops/updateConfig.js";
import {
  buildUpdateFeeRecipientsIxs,
  submitUpdateFeeRecipients,
  type UpdateFeeRecipientsParams,
} from "./ops/updateRecipients.js";
import type { SmartSubmitResult } from "./submit/smart-submit.js";

export interface OperatorInstance {
  /** Resolved config (echo of input plus any defaults filled in). */
  readonly config: OperatorConfig;
  /**
   * Read on-chain `ProtocolConfig.authority` and assert the supplied signer
   * matches. Convenience for callers that want an early `AUTHORITY_MISMATCH`
   * before submitting. Returns the on-chain authority on success.
   */
  assertProtocolAuthority(signer: Signer): Promise<PublicKey>;

  /** Build-only API — returns ixes for the caller (multisig / batching). */
  readonly build: {
    register: (
      authority: PublicKey,
      params: RegisterEndpointParams,
      poolVaultRentLamports: number,
    ) => ReturnType<typeof buildRegisterEndpointIxs>;
    pauseEndpoint: (
      authority: PublicKey,
      params: PauseEndpointParams,
    ) => ReturnType<typeof buildPauseEndpointIxs>;
    updateEndpointConfig: (
      authority: PublicKey,
      params: UpdateEndpointConfigParams,
    ) => ReturnType<typeof buildUpdateEndpointConfigIxs>;
    updateFeeRecipients: (
      authority: PublicKey,
      params: UpdateFeeRecipientsParams,
    ) => ReturnType<typeof buildUpdateFeeRecipientsIxs>;
    topUpCoveragePool: (
      authority: PublicKey,
      params: TopUpCoveragePoolParams,
    ) => ReturnType<typeof buildTopUpCoveragePoolIxs>;
  };

  /** Convenience submitters — single-signer, with smart-submit. */
  registerEndpoint: (
    authority: Signer,
    poolVault: Signer,
    params: RegisterEndpointParams,
    opts?: SmartSubmitOptions,
  ) => Promise<SmartSubmitResult>;
  pauseEndpoint: (
    authority: Signer,
    params: PauseEndpointParams,
    opts?: SmartSubmitOptions,
  ) => Promise<SmartSubmitResult>;
  updateEndpointConfig: (
    authority: Signer,
    params: UpdateEndpointConfigParams,
    opts?: SmartSubmitOptions,
  ) => Promise<SmartSubmitResult>;
  updateFeeRecipients: (
    authority: Signer,
    params: UpdateFeeRecipientsParams,
    opts?: SmartSubmitOptions,
  ) => Promise<SmartSubmitResult>;
  topUpCoveragePool: (
    poolAuthority: Signer,
    params: TopUpCoveragePoolParams,
    opts?: SmartSubmitOptions,
  ) => Promise<SmartSubmitResult>;
}

export function createOperator(config: OperatorConfig): OperatorInstance {
  if (!config.connection) {
    throw new OperatorError(
      OperatorErrorCode.CONFIG_INVALID,
      "createOperator: connection is required",
    );
  }
  if (!config.programId) {
    throw new OperatorError(
      OperatorErrorCode.CONFIG_INVALID,
      "createOperator: programId is required (no static default — devnet has no canonical id; pass PROGRAM_ID for mainnet or PROGRAM_ID_DEVNET for the broken-settlement devnet deploy)",
    );
  }
  if (!config.usdcMint) {
    throw new OperatorError(
      OperatorErrorCode.CONFIG_INVALID,
      "createOperator: usdcMint is required",
    );
  }

  const build: OperatorInstance["build"] = {
    register: (authority, params, rent) =>
      buildRegisterEndpointIxs(config, authority, params, rent),
    pauseEndpoint: (authority, params) =>
      buildPauseEndpointIxs(config, authority, params),
    updateEndpointConfig: (authority, params) =>
      buildUpdateEndpointConfigIxs(config, authority, params),
    updateFeeRecipients: (authority, params) =>
      buildUpdateFeeRecipientsIxs(config, authority, params),
    topUpCoveragePool: (authority, params) =>
      buildTopUpCoveragePoolIxs(config, authority, params),
  };

  return {
    config,
    build,
    assertProtocolAuthority: async (signer) => {
      const [pda] = getProtocolConfigPda(config.programId);
      const info = await config.connection.getAccountInfo(pda, "confirmed");
      if (!info) {
        throw new OperatorError(
          OperatorErrorCode.CONFIG_INVALID,
          `ProtocolConfig PDA ${pda.toBase58()} not found — wrong programId / not initialized on this RPC?`,
        );
      }
      const cfg = decodeProtocolConfig(info.data);
      const onChainAuth = new PublicKey(cfg.authority as never);
      if (!onChainAuth.equals(signer.publicKey)) {
        throw new OperatorError(
          OperatorErrorCode.AUTHORITY_MISMATCH,
          `signer ${signer.publicKey.toBase58()} != ProtocolConfig.authority ${onChainAuth.toBase58()}`,
          {
            details: {
              expected: onChainAuth.toBase58(),
              actual: signer.publicKey.toBase58(),
            },
          },
        );
      }
      return onChainAuth;
    },
    registerEndpoint: (authority, poolVault, params, opts) =>
      submitRegisterEndpoint(config, authority, poolVault, params, opts),
    pauseEndpoint: (authority, params, opts) =>
      submitPauseEndpoint(config, authority, params, opts),
    updateEndpointConfig: (authority, params, opts) =>
      submitUpdateEndpointConfig(config, authority, params, opts),
    updateFeeRecipients: (authority, params, opts) =>
      submitUpdateFeeRecipients(config, authority, params, opts),
    topUpCoveragePool: (poolAuthority, params, opts) =>
      submitTopUpCoveragePool(config, poolAuthority, params, opts),
  };
}
