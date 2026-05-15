# @pact-network/market-proxy-zerog

Hono proxy. Pact-0G interface in front of **0G Compute**. EVM port of
[`@pact-network/market-proxy`](../market-proxy/). It is the component that
*produces* the `SettlementEvent`s `settler-evm` consumes — the last piece of
the Galileo loop.

## Per-call flow

```
Agent → POST /v1/<slug>/chat   body: { messages: [...] }
        x-pact-agent: 0x<addr>        (EVM address)
        x-pact-signature: 0x<ECDSA>   (EIP-191 personal_sign over the payload)
        x-pact-timestamp / x-pact-nonce / x-pact-project

  1. resolveEndpoint(slug):
       static slug→{provider,model}  +  PactCore.getEndpointConfig (60s LRU)
       404 not-in-map / not-registered · 503 percentBps>0 · 503 paused
  2. ECDSA verify (viem recoverMessageAddress) → must equal x-pact-agent
  3. walletPubkey = getAddress(agent)   (settler-evm isAddress/getAddress no-op)
  4. wrapFetch(
       balanceCheck: MockUsdc.balanceOf(agent) & allowance(agent, PactCore)
       fetchImpl:    ZerogComputeClient.callInferenceWith(cached endpoint+model)
       classifier:   wrap defaultClassifier (latency vs SLA, 5xx)
       sink:         PubSubEventSink → settler-evm
     )
  5. → wrap response: X-Pact-* + x-zerog-chat-id/x-zerog-tee-verified (CORS-exposed)
```

`wrapFetch` is reused **verbatim** — it is chain-agnostic and already emits
`{ callId, agentPubkey, endpointSlug, premiumLamports, refundLamports,
latencyMs, outcome, ts }` with `agentPubkey = walletPubkey`.

## Locked decisions (plan step 5)

- **Hybrid endpoint config.** Pricing/SLA/paused are read from `PactCore`
  (authoritative — `settleBatch` trusts the premium the proxy charges); only
  the off-chain 0G-Compute `provider`/`model` routing is static
  (`DEFAULT_PROVIDERS` in `src/endpoints.ts`). No Postgres, no indexer
  dependency.
- **Demo bypass ported, env-gated off.** `?pact_wallet=<addr>` works only
  when `PACT_PROXY_INSECURE_DEMO=1` (so the later dashboard demo-runner needs
  no in-browser signing). The authenticated path is always ECDSA.
- **No `SigningMutex`.** The compute wallet only signs request headers
  off-chain (`getRequestHeaders`) + `fetch`; ledger funding is one-time at
  boot. It never races itself (unlike settler-evm BLOCKER #1).
- **SLA excludes provider discovery (5.A).** `getServiceMetadata` is resolved
  once and cached at boot; the wrapFetch-timed window is just
  `getRequestHeaders` + the inference `fetch`.
- **`percentBps>0` → 503.** wrap is flat-premium only; a percent-priced
  endpoint would be silently undercharged, so it is rejected loudly. The demo
  registers `percentBps = 0`.

## ECDSA signing contract

Canonical payload (UTF-8), identical to the Solana proxy:

```
v1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
```

The agent signs it with **EIP-191 `personal_sign`** (NOT raw `eth_sign` /
EIP-712). The proxy recovers via viem `recoverMessageAddress({ message })`
(plain string — the EIP-191 prefix is applied for you) and accepts iff the
recovered address checksum-equals `x-pact-agent`.

## Run

```bash
cp .env.example .env
pnpm --filter @pact-network/market-proxy-zerog test
pnpm --filter @pact-network/market-proxy-zerog build
pnpm --filter @pact-network/market-proxy-zerog start
```

## Status

Bodies complete; unit/integration-tested with mocked
viem/PactCore/ZerogComputeClient/Pub/Sub. **Deferred (Week-2):** the live 0G
Compute round-trip — gated on spike-2 funding (≥6 0G testnet: 3 ledger + 2
sub-account + ~1 locked/call). Real wiring is behind env; tests never hit the
network.

## Reference

- [packages/market-proxy/](../market-proxy/) — the Solana original (flow + auth + events reference)
- [packages/wrap/](../wrap/) — the chain-agnostic insurance core (reused verbatim)
- [packages/zerog-compute-client/](../zerog-compute-client/) — the 0G Compute broker wrapper
- Master plan §"Implementation step 5 — market-proxy-zerog"
