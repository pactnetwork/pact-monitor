/**
 * `@pact-network/protocol-v1-client` — TypeScript client for
 * `pact-network-v1-pinocchio`.
 *
 * Exports:
 * - PDA derivers (`getCoveragePoolPda`, `getEndpointConfigPda`, etc.)
 * - Account state types + decoders (`CoveragePool`, `decodeCoveragePool`, ...)
 * - Instruction builders (`buildRegisterEndpointIx`, `buildSettleBatchIx`, ...)
 * - SPL Token Approve/Revoke wrappers for agent custody
 * - Helpers (`defaultFeeRecipients`, `validateFeeRecipients`,
 *   `accountListForBatch`, `getAgentInsurableState`)
 * - Error code mapping (`PROTOCOL_V1_ERRORS`, `decodeProtocolError`)
 * - Constants (`PROGRAM_ID`, `USDC_MINT_DEVNET`, `MAX_FEE_RECIPIENTS`, ...)
 */

export * from "./constants.js";
export * from "./pda.js";
export {
  // State types + decoders
  decodeCoveragePool,
  decodeEndpointConfig,
  decodeCallRecord,
  decodeSettlementAuthority,
  decodeTreasury,
  decodeProtocolConfig,
  decodeFeeRecipient,
  decodeFeeRecipientArray,
  FeeRecipientKind,
  COVERAGE_POOL_LEN,
  ENDPOINT_CONFIG_LEN,
  CALL_RECORD_LEN,
  SETTLEMENT_AUTHORITY_LEN,
  TREASURY_LEN,
  PROTOCOL_CONFIG_LEN,
  FEE_RECIPIENT_LEN,
} from "./state.js";
export type {
  Pubkey,
  FeeRecipient,
  CoveragePool,
  EndpointConfig,
  CallRecord,
  SettlementAuthority,
  Treasury,
  ProtocolConfig,
} from "./state.js";

export * from "./instructions.js";
export * from "./helpers.js";
export * from "./errors.js";
