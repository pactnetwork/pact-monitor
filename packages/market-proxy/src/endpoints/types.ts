// Per-endpoint request adapters. With the proxy now layered on top of
// @pact-network/wrap, the endpoint handler is responsible only for:
//
//   1. Building the upstream Request from the inbound proxy Request
//      (URL rewriting, header forwarding, stripping pact-specific query
//      params), and
//   2. Deciding whether the request is insurable (e.g. JSON-RPC method
//      allowlist for Helius).
//
// Outcome classification has moved to `src/lib/classifiers.ts` where each
// per-endpoint classifier composes with `defaultClassifier` from
// @pact-network/wrap.

export interface EndpointHandler {
  /**
   * Translate the inbound proxy Request into the upstream Request to send
   * to the underlying API provider (e.g. Helius, Birdeye).
   */
  buildRequest(req: Request, upstreamBase: string): Promise<Request>;
  /**
   * Whether this request is eligible for Pact insurance. Returns false for
   * non-insurable JSON-RPC methods, websocket upgrades, etc. The proxy
   * passes through non-insurable requests without invoking wrap.
   */
  isInsurableMethod(req: Request): Promise<boolean>;
}
