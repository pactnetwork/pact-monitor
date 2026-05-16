# Pact-0G — 0G APAC Hackathon submission

**Pact-0G** is on-chain reliability insurance for AI agent API calls, deployed on **0G Mainnet (Aristotle, chain 16661)**. Agents pay a small premium per inference call to 0G Compute; on SLA breach the protocol refunds the agent from a coverage pool seeded by integrators. Every settlement is on-chain with explicit per-recipient fee splits, and evidence blobs land on 0G Storage.

- **Track:** Track 3 — Agentic Economy & Autonomous Applications
- **Submission deadline:** 2026-05-16, 23:59 UTC+8
- **Status:** code shipped + mainnet deployed + dashboard live. Video / X post / form submission pending.

---

## Paste-ready submission form fields

| Field | Value |
|---|---|
| **Project name** | Pact-0G |
| **One-line description** | On-chain reliability insurance for AI agent API calls — refunds agents from a per-endpoint coverage pool when 0G Compute calls breach SLO. |
| **Project repo** | https://github.com/pactnetwork/pact-monitor/tree/feat/pact-0g |
| **Submission tag (frozen)** | https://github.com/pactnetwork/pact-monitor/releases/tag/0g-apac-hackathon-2026-05-16 |
| **0G mainnet contract address** | `0xc702c3f93f73847d93455f5bd8023329a8118b7f` |
| **0G Explorer link (on-chain activity)** | https://chainscan.0g.ai/tx/0x218aa729d6f40236be617c946e9e20ee0a1726e38868c1d93ca12b93e6e14f37 |
| **Frontend demo URL** | https://pact-zerog-dashboard.vercel.app |
| **PR with full context** | https://github.com/pactnetwork/pact-monitor/pull/206 |
| **Contact email** | rick@quantum3labs.com |
| **Contact Telegram** | t.me/metalboyrick |

---

## 0G components used

| Component | Where in the code | What it does |
|---|---|---|
| **0G Chain (Aristotle 16661)** | `packages/protocol-zerog-contracts` | `PactCore.sol` — Solidity port of the v1 Pinocchio insurance program. Per-endpoint coverage pools, per-call premium debit (`transferFrom`), on-breach clamped refund, fee splits to Treasury + Affiliates, exposure-cap window. Deployed at [`0xc702c3f93f73847d93455f5bd8023329a8118b7f`](https://chainscan.0g.ai/address/0xc702c3f93f73847d93455f5bd8023329a8118b7f). |
| **0G Storage** | `packages/zerog-storage-client` | Typed wrapper over `@0gfoundation/0g-storage-ts-sdk@1.2.9`. Settler uploads per-call evidence blob (latency, breach reason, callId) and embeds the returned `rootHash` in each `CallSettled` event so judges can cross-reference on-chain settlement with the evidence on [`storagescan.0g.ai`](https://storagescan.0g.ai). |
| **0G Compute** | `packages/zerog-compute-client` + `packages/market-proxy-zerog` | Hono proxy in front of 0G Compute (model `qwen-2.5-7b-instruct` on Galileo provider `0xa48f0128…`). Wraps each agent call with ECDSA auth, balance/allowance pre-check, classifier-driven breach detection, and emits the `SettlementEvent` the settler consumes. |
| **Premium token (USDC.e)** | `0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E` | Real XSwap Bridged USDC via Chainlink CCIP from Ethereum L1. Verified on Aristotle RPC: name `Bridged USDC`, symbol `USDC.e`, 6 decimals, ~1.7M supply. The protocol moves real value, not mock tokens. |

---

## Live mainnet artifacts

All txs are on Aristotle (chain 16661):

| Step | Tx hash | Explorer |
|---|---|---|
| Deploy `PactCore` | `0x635b2b4f9106c872da5748c06cfb6feadd5f512aca9a0c1a476c0aa93b51e081` | [chainscan](https://chainscan.0g.ai/tx/0x635b2b4f9106c872da5748c06cfb6feadd5f512aca9a0c1a476c0aa93b51e081) |
| Approve `PactCore` to spend USDC.e | `0xbbb7ea1712bd161b3f9a888be8a7b6e9f10605e8017c4c5c10a1da875fa72ce5` | [chainscan](https://chainscan.0g.ai/tx/0xbbb7ea1712bd161b3f9a888be8a7b6e9f10605e8017c4c5c10a1da875fa72ce5) |
| `registerEndpoint("demo-chat")` | `0xe87647ac09864a85e0e0df85a36aa2ea5b9880157cf4a639a1b99e0704c1cf83` | [chainscan](https://chainscan.0g.ai/tx/0xe87647ac09864a85e0e0df85a36aa2ea5b9880157cf4a639a1b99e0704c1cf83) |
| `topUpCoveragePool(0.5 USDC.e)` | `0xa4b3d8986eea4ec37508fc58cba3d6903c2cd51fc29a062efbc8341ab189817d` | [chainscan](https://chainscan.0g.ai/tx/0xa4b3d8986eea4ec37508fc58cba3d6903c2cd51fc29a062efbc8341ab189817d) |
| `settleBatch` — 2 calls (1 non-breach, 1 breach with refund) | `0x218aa729d6f40236be617c946e9e20ee0a1726e38868c1d93ca12b93e6e14f37` | [chainscan](https://chainscan.0g.ai/tx/0x218aa729d6f40236be617c946e9e20ee0a1726e38868c1d93ca12b93e6e14f37) |

The settle batch tx is the most important — it carries the protocol's whole story:

- **Call #1 (non-breach):** `callId 0x4fa7c3c4…d82e`, premium 0.01 USDC.e debited, 10% to Treasury, 90% residual to the coverage pool. Status: `Settled`.
- **Call #2 (breach):** `callId 0xd998325c…41de`, premium 0.01 USDC.e debited AND 0.01 USDC.e refund paid from the coverage pool back to the agent. Status: `Settled`.

Gas: 218,699. Status: success.

---

## What judges see

### Dashboard — https://pact-zerog-dashboard.vercel.app

Read-only Next.js page that pulls `CallSettled` events directly from `PactCore` via viem against the 0G mainnet RPC. No indexer, no database. Renders:

- Protocol-state block: PactCore address, premium token, latest block height
- Last 20 settled calls: block, endpoint slug, agent, status, premium, refund, evidence rootHash, tx hash — every value linked to chainscan.0g.ai or storagescan.0g.ai

Auto-refreshes every 15 s via Next.js ISR.

### CLI — `samples/zerog-demo/`

One-shot end-to-end demo. Reads balances, deploys `PactCore` (or reuses an existing one), approves, registers an endpoint, tops up the coverage pool, settles a non-breach call + a breach call, then prints the **Submission Artifacts block** with every tx hash.

```bash
cd samples/zerog-demo
cp .env.example .env
# Edit DEPLOYER_PK — needs ~5 $0G for gas + ~1 USDC.e for the demo
pnpm install
pnpm demo
```

Idempotent: re-runs skip already-completed steps and just settle a fresh pair of calls.

---

## Architecture

```
                                       0G Mainnet (Aristotle 16661)
                                       ────────────────────────────
  ┌──────────┐    HTTP + ECDSA       ┌────────────────┐    settle_batch tx
  │  Agent   │ ─────────────────────▶│ market-proxy-  │ ─────────────────────┐
  │ (wallet) │                       │ zerog (Hono)   │                      │
  └──────────┘ ◀─── inference resp ──┴────────┬───────┘                      ▼
       │                                      │                      ┌────────────┐
       │                                      │ 0G Compute            │ PactCore   │
       │                                      └─ qwen-2.5-7b ────────▶│ (Solidity) │
       │                                                              └─────┬──────┘
       │                                                                    │
       │                                                                    │ CallSettled
       │  USDC.e premium                                                    │ RecipientPaid
       │  debited by                                                        ▼
       │  transferFrom            ┌────────────────────────────────────┐
       └─────────────────────────▶│ USDC.e — XSwap Bridged USDC        │
                                  │ 0x1f3A…473E (Chainlink CCIP)       │
                                  └────────────────────────────────────┘

  ┌──────────────────────┐            ┌──────────────────────┐
  │ settler-evm          │ writes ──▶ │ 0G Storage           │
  │ (NestJS)             │ evidence    │ rootHash → events   │
  │   ↓                  │            └──────────────────────┘
  │  reads SettlementEvent
  │  off Pub/Sub, ports the
  │  Solana settler 1:1
  └──────────────────────┘

  ┌──────────────────────┐
  │ pact-zerog-dashboard │ ◀── viem getContractEvents ─── 0G RPC
  │ (Next.js, Vercel)    │
  └──────────────────────┘
```

---

## Reproduce locally

```bash
git clone https://github.com/pactnetwork/pact-monitor.git
cd pact-monitor
git checkout 0g-apac-hackathon-2026-05-16
pnpm install

# Build the protocol contracts (needs foundry; brew install foundry or curl install)
cd packages/protocol-zerog-contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 foundry-rs/forge-std@v1.14.0
forge build
forge test -vv      # 54/54 should pass, 100% line + branch coverage

# Run the end-to-end demo against the deployed mainnet PactCore
cd ../../samples/zerog-demo
cp .env.example .env
# Set DEPLOYER_PK (wallet with ~5 $0G + ~1 USDC.e on Aristotle)
# Set PACT_CORE_ADDRESS=0xc702c3f93f73847d93455f5bd8023329a8118b7f to reuse the deployed contract
pnpm demo

# Run the dashboard locally
cd ../../packages/pact-zerog-dashboard
cp .env.example .env.local
# Set PACT_CORE_ADDRESS in .env.local
pnpm dev   # → http://localhost:3000
```

---

## Submission requirement checklist

Per the [HackQuest page](https://www.hackquest.io/hackathons/0G-APAC-Hackathon):

| Requirement | Status |
|---|---|
| Public GitHub repo with substantial commits | ✅ feat/pact-0g — 184 files, ~21k insertions, 10+ commits across 9 zerog packages |
| 0G mainnet contract address | ✅ `0xc702c3f93f73847d93455f5bd8023329a8118b7f` |
| 0G Explorer link with on-chain activity | ✅ settle_batch tx `0x218aa729…` — real USDC.e flowing through the protocol |
| At least one 0G core component | ✅ three: 0G Chain (PactCore), 0G Storage (evidence rootHash), 0G Compute (insured via market-proxy-zerog) |
| Demo video (≤3 min, must show core flow + 0G integration) | ❌ TODO |
| README with overview + architecture + 0G modules + deploy steps | ✅ this file + per-package READMEs |
| X post with `#0GHackathon #BuildOn0G @0G_labs @0g_CN @0g_Eco @HackQuest_` | ❌ TODO |
| Pitch deck (optional bonus) | ❌ optional |
| Frontend demo link (optional bonus) | ✅ https://pact-zerog-dashboard.vercel.app |
| Technical write-up on 0G integration (optional bonus) | ✅ `spikes/RESULTS.md` documents the Day-0 SDK validation (storage, compute, foundry) |

### Judging-criteria coverage

Per the page's 5 named criteria:

1. **0G Technical Integration Depth & Innovation** — uses 3 of 5 core components (Chain + Storage + Compute), real bridged USDC.e (not mock), not a thin SDK wrapper but a full protocol port with 54 contract tests at 100% coverage.
2. **Technical Implementation & Completeness** — code shipped, mainnet deployed, end-to-end settle proven on-chain. Idempotent CLI. Read-only dashboard.
3. **Product Value & Market Potential** — Pact Network already runs on Solana mainnet; the 0G port is real product expansion, not a hackathon-only build. Production stack on Solana: `market.pactnetwork.io`, `dashboard.pactnetwork.io`. AI agent reliability insurance is an underserved layer — when 0G Compute providers degrade, agents lose money silently today.
4. **User Experience & Demo Quality** — CLI prints clean paste-ready output, dashboard renders the on-chain state with chainscan/storagescan links. Brutalist design system (Inria Serif + monospace, single-page).
5. **Team Capability & Documentation** — Pact Network is the team's main product. README + per-package READMEs + `spikes/RESULTS.md` document every assumption that was tested.

---

## Known limitations (honest list)

- **No INFT (ERC-7857) integration.** The original plan called for an `EndpointINFT` minted per insured endpoint as the agent-identity token. Not implemented to ship by the deadline. Listed as a follow-up.
- **Forge verify on chainscan.0g.ai/open/api** is unproven — the explorer's `/api` returns HTML, not the verification JSON API. Sourcify fallback documented in `protocol-zerog-contracts/README.md` but not run.
- **Dashboard is read-only.** Original plan had wallet connect + a click-to-fire demo runner; both cut for the deadline. The CLI fills that role.
- **0G Compute inference call** discovery + provider routing is validated on Galileo testnet (spike 2 — see `spikes/RESULTS.md`); end-to-end inference POST through `market-proxy-zerog` was never exercised because the testnet wallet didn't have the ≥5 0G needed for the compute ledger's hard minimum. The mainnet demo uses real USDC.e but the inference call is mocked in the CLI; the proxy code is production-shaped and ready.
- **The CLI demo uses a deterministic evidence rootHash derived from callId** (not an actual 0G Storage upload). The `zerog-storage-client` package is wired and the spike round-trips real uploads on Galileo (tx `0xbe25530b…`), but the mainnet demo CLI skips the upload to keep it self-contained and fast for the video. Production settler-evm does the upload.

These cuts are intentional and documented — not bugs.

---

## Wallet

Deployer (also admin, settler, treasury for hackathon scope): `0xAD091D67886138b3a3330e2A56D33a2E06688Fc7`

Hot key — do not reuse beyond the submission. Rotate to a multisig before treating Pact-0G as a production treasury.

---

## Still to do before submission close

1. Record 3-minute demo video — show `pnpm demo`, then the dashboard, then the chainscan settle tx
2. Post on X with the four mandatory hashtags + four mandatory tags
3. Submit via the [HackQuest form](https://www.hackquest.io/hackathons/0G-APAC-Hackathon) using the table at the top of this doc
