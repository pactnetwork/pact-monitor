# @pact-network/market-proxy-zerog

Hono proxy. Pact-0G interface in front of 0G Compute. Fork of [`@pact-network/market-proxy`](../market-proxy/).

## Status

🚧 **Skeleton only.** Week 2 work.

## Per-call flow

```
Agent → POST /v1/qwen/chat/completions
        Headers: X-Pact-Agent: <addr>, X-Pact-Sig: <ECDSA over canonical message>

  1. ECDSA verify (ethers.verifyMessage) → recover signer = X-Pact-Agent
  2. ERC20 allowance check: premiumToken.allowance(agent, PactCore) >= premiumPerCall
  3. ERC20 balance check:   premiumToken.balanceOf(agent)           >= premiumPerCall
  4. wrapFetch(
       upstream: ZerogComputeClient.callInference,
       classifier: latency + status,
       sink: pubsub('pact-zerog-settlements')
     )
  5. → 200 with X-Pact-CallId, X-Pact-Latency, X-Pact-Status headers
```

## What changes vs `@pact-network/market-proxy`

| Layer | Reuse strategy |
|---|---|
| Hono routes + slug routing | reuse |
| `wrapFetch` integration | reuse — chain-agnostic |
| Agent auth | rewrite: ed25519 → ECDSA |
| Balance check | rewrite: SPL Token → ERC20 |
| Upstream call | rewrite: static URL → `ZerogComputeClient.callInference` |
| Endpoint config | swap PDA reads → `PactCoreClient.getEndpointConfig` |
