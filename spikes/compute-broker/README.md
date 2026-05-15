# Spike 2 — 0G Compute broker round-trip

**Proves:** `@0gfoundation/0g-compute-ts-sdk` can deposit, resolve a provider, send an inference request, and verify the TEE-signed response — end to end, against a real 0G Compute model on mainnet.

**Why this matters:** The Pact-0G market-proxy wraps exactly this path per call. If the SDK's surface or auth model differs from the plan, `market-proxy-zerog` changes shape.

## Prereqs

- Node 22+, pnpm
- Funded mainnet wallet (≥4 0G — 3 for the deposit, ≈1 for tx fees + per-call locked balance)

## Run

```bash
cd spikes/compute-broker

pnpm install
cp .env.example .env
# edit .env: set PRIVATE_KEY (with 0x prefix) and optionally pin PROVIDER_ADDRESS

pnpm spike
```

## Pass criteria

- All seven steps print success without throwing.
- The model reply contains `"pact-0g ok"` (or close to it).
- Latency from POST → response is recorded (we'll use this number to calibrate `latencySloMs` defaults in `PactCore` endpoint config).
- If `processResponse()` returns `true`, we have TEE-verifiable responses — that's a Track 5 stretch unlocked for free.

## Fail signals worth noting

- `createZGComputeNetworkBroker` throws → SDK version drift; check `npm view @0gfoundation/0g-compute-ts-sdk versions`.
- `listService()` returns 0 chatbots → mainnet has no chatbot services live; check docs for current model list.
- `depositFund` reverts → wallet underfunded or ledger contract address mismatch.
- POST returns 401/403 → header generation works but auth model has changed; inspect headers dump.
- `processResponse` always fails → TEE attestation path not wired; we can still ship (it's optional), but call it out in the README.

## What to record back

In [spikes/inft-erc7857/RESULTS.md](../inft-erc7857/RESULTS.md) (created after
all spikes run), capture:

- Wallet address used
- Provider address resolved + model name
- Round-trip latency in ms (3 samples)
- TEE verify pass/fail
- Any SDK methods the plan referenced that don't exist (so the plan can be amended)

## Surface differences from the original Day-0 research

The research agent reported:

- Wrong package name: `@0glabs/0g-serving-broker` → actually `@0gfoundation/0g-compute-ts-sdk`
- Non-existent `broker.inference.serve()` method → actual path is `getServiceMetadata` + `getRequestHeaders` + manual `fetch`

Both are now reflected in the spike script and the [plan file](~/.claude/plans/ok-great-lets-brainstorm-steady-stearns.md). After this spike runs, update the plan to match reality.
