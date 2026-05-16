---
name: pact-0g-demo
description: "Use when the user asks to run, demo, test, or interact with the Pact-0G CLI on 0G mainnet. Examples: \"check the agent balance\", \"make an insured call\", \"show the coverage pool\", \"trigger a breach refund\", \"run pact-0g\", \"demo the agent flow\". Pact-0G is on-chain insurance for AI agent API calls on 0G Chain — agents pay a premium per call, get refunded automatically when the call breaches SLA."
allowed-tools: Bash(pnpm *) Read Edit Write Grep Glob
---

# Pact-0G CLI

`pact-0g` is the agent-facing CLI for the Pact-0G insurance protocol on **0G Mainnet (Aristotle, chain 16661)**. Lives at `samples/zerog-demo/cli.ts`, run via `pnpm pact-0g <subcommand>` from inside that directory.

## What the protocol does

Agent makes an API call through a Pact-insured endpoint → protocol debits a premium in USDC.e → if the call breaches the SLO (latency or error), protocol refunds the agent from a per-endpoint coverage pool. All settled on-chain.

Two-wallet model:

- **Agent wallet** (`AGENT_PK` in `.env`) — holds USDC.e, signs the one-time `approve()` to PactCore.
- **Settler wallet** (`SETTLER_PK` in `.env`) — signs every `settleBatch` tx on the agent's behalf. In production this is a service the integrator runs; in the demo `.env` it's just the deployer key.

Both keys come from `samples/zerog-demo/.env`. `PACT_CORE_ADDRESS` must be set to the deployed contract.

## Commands

### `pnpm pact-0g balance`

Read-only. Print the agent's `$0G` (gas), USDC.e balance, and current allowance to PactCore.

**When to use:** anyone asking "does the agent have enough to call?" or "is the agent approved?". Always safe — no tx, no gas.

### `pnpm pact-0g approve`

Agent signs a one-time `approve(PactCore, max)` so the protocol can `transferFrom` premiums on every settle. Idempotent — skips the tx if allowance is already plenty.

**When to use:** before the agent's first `pay`, or whenever `balance` shows `approved` is 0. Costs ~0.001 $0G in gas.

### `pnpm pact-0g endpoint [slug]`

Read-only. Print the endpoint's config (flat premium, SLO ms, exposure cap) plus lifetime stats (calls, breaches, premiums collected, refunds paid). Defaults to `ENDPOINT_SLUG` from `.env` (`demo-chat`).

**When to use:** to confirm the endpoint exists, isn't paused, and shows the premium the agent will be charged. Also surfaces the lifetime breach ratio — useful for "is this endpoint reliable?".

### `pnpm pact-0g pool [slug]`

Read-only. Print the coverage pool's available balance + lifetime deposits for an endpoint.

**When to use:** to confirm the pool has enough liquidity to pay a refund before triggering a breach. If pool balance < endpoint's flat premium, a breached call would clamp the refund and the status would be `PoolDepleted` instead of `Settled`.

### `pnpm pact-0g pay [--breach] [--latency <ms>]`

State-changing. Simulates one insured call against the configured endpoint:

1. Pre-checks: agent has USDC.e ≥ premium, agent's allowance to PactCore ≥ premium, endpoint exists + not paused
2. Simulates the inference call. By default `latencyMs = 800` (success); with `--breach` it forces `latencyMs = 12000` + `HTTP 503` (breach). `--latency <ms>` overrides explicitly.
3. Classifies: `breach = latency > SLO || status >= 500 || --breach`
4. Settler wallet calls `PactCore.settleBatch([record])` on-chain
5. Reads the agent's USDC.e balance again and prints the delta

Output is in agent-perspective terms with a `[insight]` line that names what just happened in plain English.

**When to use:**
- `pact-0g pay` — show the success path (agent pays the premium, no refund). Δ is `-premium`.
- `pact-0g pay --breach` — show the breach path (agent pays the premium, gets the refund). Δ is `±0` if the pool covers the full requested refund.

This is the only command that records a `CallSettled` event on-chain. Every run produces a fresh tx hash visible on chainscan and rendered on the dashboard within ~15 s (Next.js ISR window).

## Common flows

**First-time setup for a new agent wallet:**

```bash
pnpm pact-0g balance     # verify USDC.e + $0G are funded
pnpm pact-0g approve     # one-time approval, ~0.001 $0G gas
pnpm pact-0g balance     # confirm allowance is set
```

**Verify protocol state without spending gas:**

```bash
pnpm pact-0g balance
pnpm pact-0g endpoint
pnpm pact-0g pool
```

**Fire a single insured call:**

```bash
pnpm pact-0g pay              # success path
# or
pnpm pact-0g pay --breach     # forced breach → refund
```

**Recover from `Agent allowance < premium`:**

```bash
pnpm pact-0g approve
```

## Pre-conditions

The CLI fails loudly with a clear message if any of these are missing:

| Missing | Fix |
|---|---|
| `samples/zerog-demo/.env` | Copy `.env.example` and fill `AGENT_PK`, `SETTLER_PK`, `PACT_CORE_ADDRESS` |
| `node_modules` | `pnpm install --filter @pact-network/zerog-demo...` |
| Agent has no `$0G` | Fund the agent address (read it via `pact-0g balance`) with ~0.005 $0G — only needed for `approve` |
| Settler has no `$0G` | Fund the settler with ~0.01 $0G — every `pay` burns gas there |
| Agent has no USDC.e | Bridge via [XSwap](https://xswap.link/bridge?toChain=16661) to the agent address |
| Allowance is 0 | Run `pact-0g approve` |
| Endpoint paused or unregistered | Run `pnpm demo` (the lifecycle reproducer) to (re-)register and seed the pool |

## Don'ts

- **Don't run `pact-0g pay` in a loop without checking the pool balance.** Each breach refund drains the pool by `premium`. Once empty, breached calls clamp to `PoolDepleted` instead of `Settled` — still records on-chain but no refund value moves.
- **Don't commit `.env`.** It contains both wallet private keys. The `.gitignore` already covers it.
- **Don't run `pact-0g pay` on testnet expecting it to work.** The CLI is hardcoded for Aristotle mainnet (chain 16661). Galileo testnet has a different `PactCore` address and different premium token.
- **Don't paste a private key into a chat or commit message.** Hot keys are for demo only and should be rotated to multisig before treating Pact-0G as a production treasury.

## Reference

- Source: `samples/zerog-demo/cli.ts`
- Env template: `samples/zerog-demo/.env.example`
- ABI: `@pact-network/protocol-zerog-client` (re-exported from `packages/protocol-zerog-client/src/abi.ts`)
- Live PactCore on Aristotle: [`0xc702c3f93f73847d93455f5bd8023329a8118b7f`](https://chainscan.0g.ai/address/0xc702c3f93f73847d93455f5bd8023329a8118b7f)
- Premium token (USDC.e): [`0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E`](https://chainscan.0g.ai/address/0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E)
- Dashboard: https://pact-zerog-dashboard.vercel.app — reads `CallSettled` events directly from PactCore
