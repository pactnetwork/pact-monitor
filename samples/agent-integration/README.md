# Pact Monitor — Agent Integration Examples

Copy-paste examples for the `@pact-network/monitor` SDK (no Solana deps).
For the full insurance flow (on-chain policy + claims), see [`samples/demo/external-agent.ts`](../demo/external-agent.ts) — that's the recommended end-to-end demo for external agents.

## Classification reference

`monitor.fetch()` tags every call with one of:
- `success` — 2xx + (optional) schema match + within latency budget
- `timeout` — 2xx but latency > threshold (claimable, 100% refund)
- `server_error` — 5xx, network unreachable, DNS failure (claimable, 100% refund)
- `schema_mismatch` — 2xx but body fails `expectedSchema` (claimable, 75% refund)
- `client_error` — 4xx (404, 401, 403, 429, ...) — **NOT claimable**, agent-side issue

## Prerequisites

- Backend running (`pnpm dev:backend` from project root)
- API key set: `export PACT_API_KEY=pact_your_key`

## Examples

### basic.ts — Minimal Integration
```bash
pnpm tsx samples/agent-integration/basic.ts
```
10 lines. Replace `fetch()` with `monitor.fetch()`, see local stats.

### with-schema-validation.ts — Detect Bad Responses
```bash
pnpm tsx samples/agent-integration/with-schema-validation.ts
```
Shows how APIs that return 200 but wrong body get classified as `schema_mismatch`.

### with-x402.ts — Track Payment Amounts
```bash
pnpm tsx samples/agent-integration/with-x402.ts
```
Attach USDC amounts to monitored calls. In production, the SDK auto-extracts from x402/MPP headers.
