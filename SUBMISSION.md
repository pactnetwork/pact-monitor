# Pact — on-chain insurance for AI-agent API calls (Arbitrum Sepolia)

**Arbitrum Open House London — Online Buildathon · Agentic AI track**

## The problem

Autonomous AI agents now pay for API calls — RPC, data, inference, search — on
every step of a task. When a paid call fails its SLA (a 5xx, a network drop, a
latency blow-out), the agent has already paid and has no recourse. At agent
scale (thousands of calls per task, run unattended), that unreliability compounds
into wasted spend and broken workflows, with no way to price or hedge the risk.

## What Pact does

Pact is a parametric insurance layer for agent API calls, settled entirely
on-chain. Each insured endpoint has a USDC **coverage pool**. On every call the
agent pays a small **premium** (split on-chain between the pool, the network
treasury, and the integrator). If the call **breaches its SLA**, Pact
**automatically refunds** the agent the imputed cost of the failed call plus the
premium — no claim, no adjuster, no human. The agent just calls the API through
Pact and is made whole when the upstream fails.

This is a clean fit for the **Agentic AI track**: it's financial infrastructure
*for* agents — letting an autonomous agent treat unreliable paid APIs as a
hedged, predictable cost.

## Deployed on Arbitrum Sepolia (chainId 421614)

All three contracts are deployed and **source-verified on Arbiscan**:

| Contract | Address |
|----------|---------|
| PactRegistry | [`0x79A91E5965094266d221Aaef8E66d6C364819edb`](https://sepolia.arbiscan.io/address/0x79A91E5965094266d221Aaef8E66d6C364819edb#code) |
| PactPool | [`0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc`](https://sepolia.arbiscan.io/address/0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc#code) |
| PactSettler | [`0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043`](https://sepolia.arbiscan.io/address/0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043#code) |

Settlement is in Circle test **USDC** (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, 6 decimals).

## How it works (the E2E flow)

1. An agent makes an insured API call through the Pact proxy (`/v1/:slug/*`).
2. The wrap layer checks the agent's USDC balance + allowance on-chain, forwards
   the call, and times it.
3. A classifier decides the outcome: 5xx / no-response / over-SLA = **covered
   breach**; 4xx (incl. 429) = not covered.
4. On a breach, the off-chain settler submits `settleBatch` to **PactSettler** on
   Arbitrum Sepolia — pulling the premium and paying the refund (imputed cost +
   premium) from the pool to the agent, with explicit per-recipient fee splits.
5. The indexer ingests the settlement; the dashboard shows pools, premiums,
   refunds, and breach rate.

**Live settle tx (insured-call breach → on-chain refund):**
[`0x4754ee52f0fd04bb3383897a4ae772f3a6dae1c331ad167565e6499db310b6b1`](https://sepolia.arbiscan.io/tx/0x4754ee52f0fd04bb3383897a4ae772f3a6dae1c331ad167565e6499db310b6b1)
— a real insured call to a forced-503 endpoint through the public proxy: agent paid 1000 premium, received an 11000 refund (imputed cost + premium), network treasury earned 100 (10% cut), all settled on Arbitrum Sepolia by the live settler. Visible on the public dashboard.

## Architecture

- **On-chain (Solidity / Foundry):** PactRegistry (endpoints + fee config),
  PactPool (per-endpoint USDC coverage pools), PactSettler (batched on-chain
  settlement, `SETTLER_ROLE`-gated). Generic, chain-agnostic.
- **Off-chain (TypeScript):** market-proxy (Hono insured proxy), settler
  (NestJS oracle cranker), indexer (NestJS ingest + read API), market-dashboard
  (Next.js). All select the chain by `PACT_ENABLED_NETWORKS` — Arbitrum Sepolia
  is a config entry, not a fork.

## Links

- **Repo:** https://github.com/pactnetwork/pact-monitor (branch `feat/arbitrum-sepolia-deploy`, PR #267)
- **Verified contracts:** Arbiscan links above
- **Live dashboard (Railway):** https://market-dashboard-production-0489.up.railway.app
- **Live insured proxy (Railway):** https://market-proxy-production-29f9.up.railway.app (`/health`, insured `/v1/dummy/*`)
- **Live indexer API (Railway):** https://indexer-production-52a9.up.railway.app (`/api/stats`, `/api/endpoints`)
- **Settle tx:** https://sepolia.arbiscan.io/tx/0x4754ee52f0fd04bb3383897a4ae772f3a6dae1c331ad167565e6499db310b6b1
- **Runbook:** [`DEPLOY-ARBITRUM-SEPOLIA.md`](./DEPLOY-ARBITRUM-SEPOLIA.md)
- **Demo video:** _TBD_

> Deadline note: confirm the exact HackQuest submission cutoff time + timezone
> and the required form fields before submitting (June 14, 2026; time unconfirmed).
