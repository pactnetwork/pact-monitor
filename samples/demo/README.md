# Pact Network — Demo Scripts

Runnable demos that exercise both SDKs (`@q3labs/pact-monitor` and
`@q3labs/pact-insurance`) against real Solana APIs and a local backend.

## Setup

```bash
cd samples/demo
cp .env.example .env
```

Edit `.env` with your Pact API key (generate with `pnpm run generate-key demo` from project root).

Optionally add Helius/QuickNode keys for more providers.

## Monitor demos

> **All demos are invoked as `pnpm run <name>`** (not `pnpm tsx <file>`).
> The `pnpm run` form chains a `build:deps` step that builds the workspace
> SDKs first, so the demos work from a fresh clone with no prior `pnpm
> build`. Running `pnpm tsx insurance-basic.ts` directly will fail with
> `ERR_MODULE_NOT_FOUND` until the SDKs are built.

### `monitor.ts` — live reliability monitoring
```bash
pnpm run monitor          # default 5 rounds
pnpm run monitor 10       # custom rounds
```

Open the scorecard at http://localhost:5173 to see results appear live.

## Insurance demos

### `external-agent.ts` — full happy path (recommended for first-time external agents)
```bash
pnpm run external-agent api.coingecko.com 3
```
End-to-end: load/generate keypair, fund SOL + USDC via the public faucet
(no Phantom mint authority required), self-provision an API key via
`POST /api/v1/keys/self-serve`, enable insurance, run 3 successful
`monitor.fetch()` calls, force a `timeout` (claimable) and a `404` (not
claimable), verify the on-chain refund. This is the demo
`docs/agent-quickstart.md` points new developers at.

### `insurance-basic.ts` — read-only SDK demo (safe to run cold)
```bash
pnpm run insurance-basic api.coingecko.com
```
**Read-only**: calls `estimateCoverage` and `getPolicy` only. Does not
send a transaction, does not need a funded keypair, does not need
TEST-USDC. Safe to run from a fresh clone with zero pre-reqs — the
`build:deps` chain builds the SDKs and the demo generates an ephemeral
keypair if the configured path doesn't exist. Use this to confirm the
SDK can talk to the chain before running the full write flow in
`external-agent.ts`.

### `monitor-plus-insurance.ts` — both SDKs composed
```bash
pnpm run monitor-plus-insurance api.coingecko.com
```
Wires both SDKs: `monitor.fetch()` records calls with a signed batch keypair,
`PactInsurance` owns the on-chain policy, `monitor.on("failure")` hooks
local alerting. Backend auto-submits claims; shows the manual
`insurance.submitClaim()` path too. Pre-reqs: existing policy on-chain
(run `external-agent.ts` first).

### `insured-agent.ts` — INTERNAL ONLY (requires Phantom mint authority)
The team's reference demo for the full Phase 3 flow. Requires
`~/.config/solana/phantom-devnet.json` (the test-USDC mint authority).
External developers should use `external-agent.ts` instead.
