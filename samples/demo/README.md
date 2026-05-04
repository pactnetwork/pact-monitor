# Pact Network — Demo Scripts

Runnable demos that exercise both SDKs (`@pact-network/monitor` and
`@pact-network/insurance`) against real Solana APIs and a local backend.

## Setup

```bash
cd samples/demo
cp .env.example .env
```

Edit `.env` with your Pact API key (generate with `pnpm run generate-key demo` from project root).

Optionally add Helius/QuickNode keys for more providers.

## Monitor demos

### `monitor.ts` — live reliability monitoring
```bash
pnpm tsx monitor.ts          # default 5 rounds
pnpm tsx monitor.ts 10       # custom rounds
```

Open the scorecard at http://localhost:5173 to see results appear live.

## Insurance demos

### `external-agent.ts` — full happy path (recommended for first-time external agents)
```bash
pnpm tsx external-agent.ts api.coingecko.com 3
```
End-to-end: load/generate keypair, fund SOL + USDC via the public faucet
(no Phantom mint authority required), self-provision an API key via
`POST /api/v1/keys/self-serve`, enable insurance, run 3 successful
`monitor.fetch()` calls, force a `timeout` (claimable) and a `404` (not
claimable), verify the on-chain refund. This is the demo
`docs/agent-quickstart.md` points new developers at.

### `insurance-basic.ts` — read-only SDK demo (safe to run cold)
```bash
pnpm tsx insurance-basic.ts api.coingecko.com
```
**Read-only**: calls `estimateCoverage` and `getPolicy` only. Does not
send a transaction, does not need a funded keypair, does not need
TEST-USDC. Safe to run from a fresh clone with zero pre-reqs — if the
keypair file doesn't exist, the demo generates an ephemeral one. Use
this to confirm the SDK can talk to the chain before running the full
write flow in `external-agent.ts`.

### `monitor-plus-insurance.ts` — both SDKs composed
```bash
pnpm tsx monitor-plus-insurance.ts api.coingecko.com
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
