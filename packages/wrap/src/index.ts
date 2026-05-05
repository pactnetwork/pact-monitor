// @pact-network/wrap — Network-core fetch-call wrap library.
//
// Skeleton package. Real implementation lands in Step D.0 of the layering
// refactor (see docs/superpowers/plans/2026-05-05-network-market-layering-and-
// v1-v2-rename.md §4 + Step D).
//
// Planned exports:
//   - wrapFetch(opts)                       — request lifecycle: timer →
//                                             balance check → forward →
//                                             classify → emit event → headers
//   - BalanceCheck (interface + default)    — read agent USDC ATA balance +
//                                             SPL Token delegated_amount
//   - Classifier (interface + default)      — latency/5xx/429/network-error
//                                             classification; consumers add
//                                             per-endpoint plugins
//   - EventSink (interface + impls)         — PubSubEventSink, HttpEventSink,
//                                             MemoryEventSink
//   - SettlementEvent (re-export from shared)
//   - X-Pact-* header constants

export const PLACEHOLDER_VERSION = "0.1.0";
