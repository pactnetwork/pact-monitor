# @pact-network/wrap

Network-core fetch-call wrap library. Generic primitive for insuring an arbitrary HTTP fetch against Pact Network.

## Layer

**Network rails.** This package is part of Pact Network core, not Pact Market. Any interface — Pact's own market proxy, a third-party SDK, an x402 facilitator integration, a BYO-provider wrapper — consumes this library to wrap a fetch call.

## Status

Skeleton. Real implementation lands in Step D.0 of the layering refactor. See `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md` §4 (the API contract) and Step D (the implementation work).

## Planned API

```ts
import {
  wrapFetch,
  PubSubEventSink,
  defaultClassifier,
} from "@pact-network/wrap";

const sink = new PubSubEventSink({ project, topic });
const response = await wrapFetch({
  endpointSlug: "helius",
  walletPubkey: agentWallet,
  upstreamUrl: "https://mainnet.helius-rpc.com/?api-key=KEY",
  init: { method: "POST", body },
  classifier: defaultClassifier, // or a per-endpoint plugin
  sink,
});
```

If this snippet works against a network where the endpoint is registered with a custom integrator/affiliate pubkey, Pact Network core has shipped without depending on Pact Market.

## Sub-packages this exposes

- `wrapFetch(opts)` — full request lifecycle.
- `BalanceCheck` — pluggable; default reads agent USDC ATA balance + SPL Token `delegated_amount`.
- `Classifier` — pluggable; default handles latency vs `sla_latency_ms`, 5xx → `server_error`, 429 → `client_error`, network-error → `server_error`.
- `EventSink` — `PubSubEventSink`, `HttpEventSink`, `MemoryEventSink`.
- `X-Pact-*` header constants and `SettlementEvent` schema.

Per-endpoint classifier *plugins* (e.g., Helius JSON-RPC, Birdeye REST) live in the consuming interface, not in this library.
