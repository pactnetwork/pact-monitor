// @pact-network/wrap — Network-core fetch-call wrap library.
//
// Real implementation (Step D.0 of the layering refactor). See:
//   docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md
//   §4 (the API contract)
//
// Per-endpoint classifier plugins (Helius, Birdeye, Jupiter, etc.) live in
// the consumer (e.g. @pact-network/market-proxy), NOT in this library.

export { wrapFetch } from "./wrapFetch";
export type { WrapFetchOptions, WrapFetchResult } from "./wrapFetch";

export { defaultClassifier, composeWithDefault } from "./classifier";
export type { Classifier, ClassifierInput, ClassifierResult } from "./classifier";

export { createDefaultBalanceCheck } from "./balanceCheck";
export type {
  BalanceCheck,
  BalanceCheckResult,
  BalanceCheckRejectionReason,
  DefaultBalanceCheckOptions,
} from "./balanceCheck";

export {
  MemoryEventSink,
  HttpEventSink,
  PubSubEventSink,
  RedisStreamsEventSink,
} from "./eventSink";
export type {
  EventSink,
  HttpEventSinkOptions,
  PubSubEventSinkOptions,
  PubSubTopicPublisher,
  RedisStreamsEventSinkOptions,
  RedisStreamPublisher,
} from "./eventSink";

export { HEADERS, attachPactHeaders } from "./headers";
export type { PactHeaderInputs } from "./headers";

export type { Outcome, EndpointConfig, SettlementEvent } from "./types";
