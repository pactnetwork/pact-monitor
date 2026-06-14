# HackQuest submission — Arbitrum Open House London: Online Buildathon

Copy-paste answers for the "Submission Project" form. Char-limited fields kept under 300.

## Select the Project to Submit*
Pact (your HackQuest project entry — create/select "Pact" if not listed)

## What is your contract address?*
```
0x79A91E5965094266d221Aaef8E66d6C364819edb
```
(PactRegistry — the protocol entry point, deployed + verified on Arbitrum Sepolia, chainId 421614)

## Which Prize Track Do You Belong To* (select all that apply)
- ✅ **Best Agentic Project** (primary — Pact is financial infra *for* AI agents)
- ✅ **Overall prize** (also eligible)
- ⬜ **Grants** (optional — select if requesting Arbitrum Foundation grant consideration)

## Link to frontend/UI/website* (≤300)
```
https://market-dashboard-production-0489.up.railway.app
```

## List your Core Protocol / Smart Contract Addresses* (≤300)
```
PactRegistry: 0x79A91E5965094266d221Aaef8E66d6C364819edb | PactPool: 0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc | PactSettler: 0x8b8D5baF16bB15D5950d2C4cC76879D5b8a74043 — Arbitrum Sepolia (421614), all Arbiscan-verified
```

## List your Factory/Pool Contracts (if applicable)* (≤300)
```
PactPool: 0xe685b4d5d2AaF0a54f988AF6F44Ca799Cb0660cc — per-endpoint USDC coverage pools (one balance per insured endpoint slug); topUp/payout/debit gated to PactSettler via SETTLER_ROLE.
```

---

## Likely fields below the fold — prepared answers

### Project name / tagline
```
Pact — on-chain parametric insurance for AI-agent API calls
```

### Short description (1–2 lines)
```
AI agents pay for API calls (RPC, data, inference) on every step. When a paid call fails its SLA (5xx, timeout, network drop) the agent has already paid with no recourse. Pact debits a small USDC premium per call and automatically refunds the agent on-chain when the call breaches — no claim, no human.
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

We kept hitting the same wall building agents: they pay for almost every step now — RPC, market data, inference, search — and when a call flakes out, the money's already gone. A 503, a timeout, a dropped connection, and the agent just eats it. One call, who cares. But agents don't make one call. They make thousands, unattended, and that waste compounds into blown budgets and half-finished tasks nobody's watching.

So we built Pact: insurance for agent API calls, settled on-chain.

It's simple. Every insured endpoint has a USDC coverage pool. When an agent makes a call through Pact, it pays a tiny premium. If the call comes back healthy, the premium gets split on-chain — most stays in the pool, a cut to the network treasury, a cut to whoever integrated the endpoint. If the call breaches its SLA — a 5xx, no response, or it blew past the latency bound — Pact refunds the agent automatically: the imputed cost of the failed call plus the premium back. No claim form, no adjuster, no human in the loop. The agent just gets made whole, on-chain, in the same flow.

That last part is the point. This isn't a dashboard a human checks. It's infrastructure an autonomous agent leans on — it turns "this API might fail and I'm out the money" into a hedged, predictable line item the agent can reason about. That's why we built it for the agentic track.

For the Open House we brought the whole thing to Arbitrum. The protocol's three contracts — registry, pool, settler — are deployed and verified on Arbitrum Sepolia, and the full off-chain stack (the insured proxy, the settler, the indexer, the dashboard) runs live against it. We proved it end to end: a real insured call to an endpoint we forced to 503, an automatic on-chain refund to the agent, the treasury taking its cut — all of it landing in one Arbitrum transaction you can open and read. Picked Arbitrum because cheap, fast finality is exactly what per-call insurance needs; you can't settle a $0.001 premium on an L1.

## Progress timeline — Arbitrum Open House London (May 25 – June 14)

Anchored to real commits. The multi-chain EVM foundation came together across the
buildathon; Arbitrum was the chain we shipped it on at the end.

- **May 15 — Groundwork.** Wrote the EVM-expansion design: deep chain comparison, picked an EVM target, locked the work-package plan. (The protocol itself — Pinocchio on Solana — already existed; this was the port plan.)
- **May 26 — Agent identity on EVM.** Landed secp256k1 / EIP-191 signing in the SDK, taught the proxy to accept network-tagged signed payloads, and made the indexer sync EVM endpoints from the on-chain registry.
- **May 27–29 — Make it actually settle.** Multi-network smoke testing; the EVM settler now signs `settleBatch` locally and submits via `eth_sendRawTransaction`; baked `chains.json` into a typed const with a CI drift guard; fixed the service Docker images; redacted secrets from logs; closed an EVM replay-cache bypass.
- **June 2–4 — One image, many chains.** Stripped the old V2 stack, isolated the build, then wired Base mainnet addresses + deploy block and shipped per-network isolation so one fleet can run several chains without crosstalk.
- **June 5–9 — Multi-network ships.** Gated the legacy Solana path behind `PACT_ENABLED_NETWORKS` so a chain can boot standalone; merged multi-network 0.3.0 to main (multi-VM, Arc Testnet, Base Sepolia, CLI/SDK headers).
- **June 11 — Isolation hardening.** Conditionalized the Solana env contract on enabled networks; added tests proving an isolated settler ack-skips foreign-network events.
- **June 12–14 — Arbitrum.** Added Arbitrum Sepolia as a chain entry (drift-tested across all three sources), deployed + Arbiscan-verified the three contracts, stood up the full stack on Railway with public URLs, registered an endpoint, and ran the end-to-end proof: insured call → forced 503 breach → on-chain refund settled by the live settler (tx `0x4754ee52…b6b1`), reflected on the public dashboard.
