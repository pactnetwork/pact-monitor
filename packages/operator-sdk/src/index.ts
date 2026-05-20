/**
 * @q3labs/pact-operator-sdk
 *
 * Operator-side SDK for Pact Network V1. Caller holds the protocol authority
 * key (or a CoveragePool authority key for topup) and runs endpoint
 * onboarding / config / pause / fee-split ops.
 *
 * IMPORTANT — V1 constraints (do not over-promise):
 * - There is NO `withdraw_from_pool` instruction. Fees auto-distribute
 *   per-settlement via `settle_batch`'s fee fan-out (see
 *   `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs`).
 *   Affiliates earn passively into their ATA.
 * - Endpoint config / pause / fee-recipient ops require
 *   `ProtocolConfig.authority` (singleton).
 * - `top_up_coverage_pool` is the ONLY op that uses `CoveragePool.authority`
 *   (per-pool) — this asymmetry is real and intentional. The submitter
 *   `submitTopUpCoveragePool` pre-flights this distinct authority.
 *
 * Multisig: for a Squads-held protocol authority, take the returned
 * `TransactionInstruction[]` from `operator.build.*(authority, ...)` and
 * wrap them in `@sqds/multisig` `vaultTransactionCreate` → `proposalCreate`
 * → `proposalApprove` × N → `vaultTransactionExecute`. The SDK never
 * abstracts the multisig flow — that contract is too leaky to wrap.
 */
export { createOperator } from "./factory.js";
export type { OperatorInstance } from "./factory.js";
export type { OperatorConfig, SmartSubmitOptions } from "./config.js";
export { OperatorError, OperatorErrorCode, isOperatorError } from "./errors.js";
export {
  smartSubmit,
  type SmartSubmitArgs,
  type SmartSubmitResult,
} from "./submit/smart-submit.js";
export {
  buildRegisterEndpointIxs,
  submitRegisterEndpoint,
  type RegisterEndpointParams,
  type BuildRegisterEndpointResult,
} from "./ops/register.js";
export {
  buildPauseEndpointIxs,
  submitPauseEndpoint,
  type PauseEndpointParams,
} from "./ops/pauseEndpoint.js";
export {
  buildUpdateEndpointConfigIxs,
  submitUpdateEndpointConfig,
  type UpdateEndpointConfigParams,
} from "./ops/updateConfig.js";
export {
  buildUpdateFeeRecipientsIxs,
  submitUpdateFeeRecipients,
  type UpdateFeeRecipientsParams,
} from "./ops/updateRecipients.js";
export {
  buildTopUpCoveragePoolIxs,
  submitTopUpCoveragePool,
  type TopUpCoveragePoolParams,
} from "./ops/topup.js";
