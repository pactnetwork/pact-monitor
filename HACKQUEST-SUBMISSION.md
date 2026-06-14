# HackQuest submission — Arbitrum Open House London: Online Buildathon

Copy-paste answers for the "Submission Project" form. Char-limited fields kept under 300.

## Select the Project to Submit*
Pact Network (your HackQuest project entry — create/select "Pact Network" if not listed)

## What is your contract address?*
```
0x79A91E5965094266d221Aaef8E66d6C364819edb
```
(PactRegistry — the protocol entry point, deployed + verified on Arbitrum Sepolia, chainId 421614)

## Which Prize Track Do You Belong To* (select all that apply)
- ✅ **Best Agentic Project** (primary — Pact Network is financial infra *for* AI agents)
- ✅ **Overall prize** (also eligible)
- ⬜ **Grants** (optional — select if requesting Arbitrum Foundation grant consideration)

## Link to frontend/UI/website* (≤300)
```
https://market-dashboard-production-0489.up.railway.app
```

## List your Core Protocol / Smart Contract Addresses* (≤300)
```
Arbitrum Sepolia: 0x79A91E5965094266d221Aaef8E66d6C364819edb — PactRegistry (endpoints + fees)
Arbitrum Sepolia: 0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc — PactPool (coverage pools)
Arbitrum Sepolia: 0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043 — PactSettler (settlement)
```

## List your Factory/Pool Contracts (if applicable)* (≤300)
```
Arbitrum Sepolia: 0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc — PactPool (per-endpoint USDC coverage pools; one balance per endpoint slug)
```

---

## Likely fields below the fold — prepared answers

### Project name / tagline
```
Pact Network — on-chain parametric insurance for AI-agent API calls
```

### Short description (1–2 lines)
```
AI agents pay for API calls (RPC, data, inference) on every step. When a paid call fails its SLA (5xx, timeout, network drop) the agent has already paid with no recourse. Pact Network debits a small USDC premium per call and automatically refunds the agent on-chain when the call breaches — no claim, no human.
```

### Full description / how it works
```
Each insured endpoint has a USDC coverage pool. On every call the agent pays a premium, split on-chain between the pool, the network treasury, and the integrator. A classifier marks 5xx / no-response / over-SLA as a covered breach (4xx is not covered). On a breach, an off-chain settler submits settleBatch to PactSettler on Arbitrum Sepolia, paying the refund (imputed cost + premium) from the pool to the agent. Everything settles on-chain with explicit per-recipient fee splits. It's financial infrastructure for autonomous agents: it lets an agent treat unreliable paid APIs as a hedged, predictable cost.
```

### GitHub repo
```
https://github.com/pactnetwork/pact-monitor (branch feat/arbitrum-sepolia-deploy, PR #267)
```

### Demo / proof links
- Live dashboard: https://market-dashboard-production-0489.up.railway.app
- Live insured proxy: https://market-proxy-production-29f9.up.railway.app
- Verified contracts (Arbiscan): https://sepolia.arbiscan.io/address/0x79A91E5965094266d221Aaef8E66d6C364819edb#code
- **Live settle tx (insured call → breach → on-chain refund):** https://sepolia.arbiscan.io/tx/0x4754ee52f0fd04bb3383897a4ae772f3a6dae1c331ad167565e6499db310b6b1
- Demo video: _add link_

### Network / chain
```
Arbitrum Sepolia (chainId 421614)
```

### What's deployed (proof of working E2E)
```
3 verified contracts on Arbitrum Sepolia + a full off-chain stack (proxy, settler, indexer, dashboard) live on Railway. A real insured call to a forced-503 endpoint settled on-chain: agent paid 1000 premium (USDC 6dp), received 11000 refund, treasury earned 100 — tx 0x4754ee52...b6b1, visible on the public dashboard.
```

---

## Humanized project description (founder voice)

We build AI agents. Every agent step now costs money. It pays for RPC calls, market data, inference, and search. When a paid call fails, the money is already gone. The agent gets a 503, a timeout, or no response, and it does not get the money back. One failed call is small. But agents do not make one call. They make thousands, with no person watching. The small losses add up, and tasks do not finish.

So we built Pact Network: on-chain insurance for agent API calls.

Each insured endpoint has a USDC coverage pool. When an agent makes a call through Pact Network, it pays a small premium. If the call succeeds, the premium is split on-chain: most stays in the pool, a part goes to the network treasury, and a part goes to the integrator. If the call fails its SLA (a 5xx error, no response, or too slow), Pact Network refunds the agent on-chain. The agent gets back the cost of the failed call plus the premium. There is no claim form and no person in the loop.

We built Pact Network for Arbitrum. Arbitrum has low fees and fast finality, which is what per-call insurance needs. You cannot settle a $0.001 premium on Ethereum mainnet. To get there, we first built a chain-agnostic EVM layer, then deployed our protocol on Arbitrum. The three contracts (registry, pool, settler) are live and verified on Arbitrum Sepolia. The full off-chain stack (proxy, settler, indexer, dashboard) runs live against it. We proved it end to end: a real insured call to an endpoint we forced to return 503, an automatic on-chain refund to the agent, and the treasury taking its cut. All of it landed in one Arbitrum transaction you can open and read.

## Progress timeline — Arbitrum Open House London

Our goal was to deploy Pact Network on Arbitrum. To do that, we first built a chain-agnostic EVM layer, then launched on Arbitrum. The buildathon ran May 25 – June 14; our Arbitrum design started just before it (May 15). Every step is anchored to a real git commit.

- **Before the buildathon (May 15) — EVM plan for Arbitrum.** We wrote the EVM-expansion design, compared chains, and chose Arbitrum as the target. We then locked the work-package plan. (The core protocol, written in Pinocchio on Solana, already existed. This was the plan to port it to EVM.)
- **May 26 — Agent identity on EVM.** We added secp256k1 / EIP-191 signing to the SDK, taught the proxy to accept network-tagged signed payloads, and made the indexer sync EVM endpoints from the on-chain registry.
- **May 27–29 — On-chain settlement on EVM.** We ran multi-network smoke tests. The EVM settler now signs `settleBatch` locally and submits it with `eth_sendRawTransaction`. We moved `chains.json` into a typed constant with a CI drift guard, fixed the Docker images, redacted secrets from logs, and closed an EVM replay-cache bypass.
- **June 2–4 — One image, many chains.** We removed the old V2 stack, isolated the build, and added per-network isolation. One fleet can now run several chains at once with no crosstalk.
- **June 5–9 — Multi-network release.** We gated the legacy Solana path behind `PACT_ENABLED_NETWORKS` so a single chain can boot on its own. We then merged multi-network 0.3.0 to main.
- **June 11 — Isolation hardening.** We made the Solana env config depend on the enabled networks, and added tests that prove an isolated settler skips events from other networks.
- **June 12–14 — Arbitrum launch.** We added Arbitrum Sepolia as a chain entry, deployed and Arbiscan-verified the three contracts, and stood up the full stack on Railway with public URLs. We registered an endpoint and ran the full proof: insured call, forced 503 breach, and on-chain refund settled by the live settler (tx `0x4754ee52…b6b1`), shown on the public dashboard.

---

## Bottom-of-form fields (confirmed from the form)

### List your Token Contract Address (if applicable)* (≤300)
```
N/A — Pact Network has no project token. Settlement is in Circle's test USDC (0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, 6 decimals) on Arbitrum Sepolia.
```

### Which parts of your code have been produced during the Buildathon?* (≤300)
```
Existing public monorepo. Built during the buildathon: the whole EVM/Arbitrum layer. Arbitrum Sepolia integration, deploy + Arbiscan verify (PR #267), EVM settler, EVM agent identity (secp256k1/EIP-191), proxy/indexer EVM adapters, per-network isolation. Structured commits May 26 to Jun 14. Solana core predates it.
```

> Repo is **public** (`github.com/pactnetwork/pact-monitor`) with conventional/structured commits, so judges can verify progress directly — no `engineering-AF` invite needed. Buildathon work lands in PR #267 (Arbitrum deploy) + the EVM/multi-network commits May 26–Jun 14; the Solana core protocol predates the buildathon.

### Which sponsor/partner technologies have you used?* (select)
- ✅ **OpenZeppelin** — contracts use OZ AccessControl + SafeERC20 (foundry remapping `@openzeppelin/`).
- (Optional/weak: **Alchemy** — only used its faucet for testnet ETH, not integrated in code. Select only if faucet use counts.)
- Not used: GMX, Robinhood Chain, Dune Analytics, ZeroDev, Fhenix, AWS.

---

## Where the separate (mandatory) fields live
- **Description** → the "Humanized project description (founder voice)" section above.
- **Progress during Hackathon** → the "Progress timeline — Arbitrum Open House London" section above.
