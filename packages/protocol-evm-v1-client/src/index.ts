/**
 * `@pact-network/protocol-evm-v1-client` — TypeScript client (viem) for the
 * Pact Network EVM v1 protocol contracts on Circle Arc.
 *
 * Sibling to `@pact-network/protocol-v1-client` (Solana); mirrors its module
 * map (design spec §5):
 * - PDA derivers -> deployed addresses per chain (`addresses.ts`)
 * - instruction builders -> viem calldata builders (`encode.ts`)
 * - account decoders -> view-call + event decoders (`state.ts`)
 * - error-code map -> custom-error selector map (`errors.ts`)
 * - constants + ABI re-export (`constants.ts`)
 * - fee-recipient helpers (`helpers.ts`)
 *
 * Consumed by the settler `ChainAdapter` and the indexer per-chain poller
 * (design §6.2) — parity that stops at the contract is not parity (corrects
 * PR #201 §7.1).
 */

/** Package version (mirrors package.json). */
export const PROTOCOL_EVM_V1_CLIENT_VERSION = "0.1.0";

export * from "./constants.js";
export * from "./addresses.js";
export * from "./encode.js";
export * from "./errors.js";
export * from "./helpers.js";
export {
  SettlementStatus,
  FeeRecipientKind,
  decodeEndpointConfig,
  decodePoolState,
  decodeIsRegistered,
  decodeProtocolPaused,
  decodeAuthority,
  decodeTreasuryVault,
  decodeMaxTotalFeeBps,
  decodePactEventLog,
} from "./state.js";
export type {
  FeeRecipient,
  EndpointConfig,
  PoolState,
  DecodedPactEvent,
} from "./state.js";
