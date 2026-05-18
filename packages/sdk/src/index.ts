/**
 * `@pact-network/sdk` — unified Pact Network agent SDK.
 *
 * `createPact()` returns a `pact.fetch()` that transparently routes covered
 * calls through the Pact Market proxy (auto-refund on breach, V1), manages
 * the one-time global SPL approve, and surfaces typed events. It never breaks
 * the caller's call: any Pact-internal failure degrades to a bare fetch.
 */
export { createPact } from "./factory.js";
export type { PactInstance, PactFetchCallOptions } from "./factory.js";

export { PactError, PactErrorCode, isPactError } from "./errors.js";
export type { PactConfig, AutoTopUpConfig } from "./config.js";
export type { Network } from "./network.js";
export type { PactSigner, WalletAdapterSigner } from "./signer.js";

export type {
  PactEventMap,
  PactEventName,
  FailureEvent,
  RefundEvent,
  BilledEvent,
  LowBalanceEvent,
  DegradedEvent,
} from "./events.js";
export type {
  AgentPolicyState,
  AgentStats,
  ClaimRecord,
  PremiumEstimate,
} from "./state.js";
