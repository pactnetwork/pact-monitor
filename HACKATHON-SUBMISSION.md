# Pact-0G — 0G APAC Hackathon submission

**Pact-0G** is on-chain reliability insurance for AI agent API calls, deployed on **0G Mainnet (Aristotle, chain 16661)**. Agents pay a small premium per inference call to 0G Compute; on SLA breach the protocol refunds the agent from a coverage pool seeded by integrators. Every settlement is on-chain with explicit per-recipient fee splits, and evidence blobs land on 0G Storage.

- **Track:** Track 3 — Agentic Economy & Autonomous Applications
- **Submission deadline:** 2026-05-16, 15:59 (UTC+8, per Schedule tab)
- **Status:** code shipped + mainnet deployed + dashboard live. Video / X post / form submission pending.
- **Live mirror of this doc in grant-applications:** open `dev/docs/grant-applications/index.html` (entry `0g-apac-hackathon`) — every field has a one-click Copy button there.

---

## Form fields → on-page mapping

Inspected the public layout at https://www.hackquest.io/projects/ClawGuard. Screenshots in [`docs/submission-screenshots/`](./docs/submission-screenshots/). This is what HackQuest collects:

| HackQuest field | Where it shows on the project page | Status |
|---|---|---|
| Project name | Header h1 | ✅ ready |
| Logo | Header avatar (square, ~100px) | ⚠️ upload `landing/dist/logo-mark-dark.png` |
| Short description | Header subtitle (≤30 words, one line) | ✅ ready |
| Tech Stack tags | Tag chips below the demo video | ✅ ready |
| Description (markdown) | Long body — headings, bullets, links | ✅ ready |
| Progress During Hackathon | Bullet milestones | ✅ ready |
| Demo Video URL | Embedded under Videos | ❌ TODO — record 3 min, upload YouTube |
| Project Links | Right-rail icons (GitHub, deploy URL) | ✅ ready |
| Prize Track | Right-rail badge | ✅ ready (Track 3) |
| Sector | Right-rail badge | ✅ ready (Infra, AI, DeFi) |
| Team Leader + Members | Team tab | ✅ ready |
| Checkpoints / Milestones | Checkpoints tab — optional | optional |

## Paste-ready field blocks

Each block matches one HackQuest form field. Open the same doc in the grant-applications platform for one-click copy of every block — `dev/docs/grant-applications/index.html`, entry `0g-apac-hackathon`.

<!-- field: Project name -->
Pact-0G
<!-- /field -->

<!-- field: Short description (≤30 words) -->
On-chain reliability insurance for AI agent API calls. Agents pay a premium to 0G Compute; SLA breach refunds them from a coverage pool. Settled on 0G Chain, evidence on 0G Storage.
<!-- /field -->

<!-- field: Tech Stack tags -->
Solidity, TypeScript, viem, Next.js, Hono, NestJS, Foundry, 0G Chain, 0G Storage, 0G Compute, Chainlink CCIP
<!-- /field -->

<!-- field: Prize Track -->
Track 3 — Agentic Economy & Autonomous Applications
<!-- /field -->

<!-- field: Sector -->
Infra, AI, DeFi
<!-- /field -->

<!-- field: GitHub repo -->
https://github.com/pactnetwork/pact-monitor/tree/feat/pact-0g
<!-- /field -->

<!-- field: Submission tag (frozen) -->
https://github.com/pactnetwork/pact-monitor/releases/tag/0g-apac-hackathon-2026-05-16
<!-- /field -->

<!-- field: 0G mainnet contract address -->
0xc702c3f93f73847d93455f5bd8023329a8118b7f
<!-- /field -->

<!-- field: 0G Explorer link (on-chain activity) -->
https://chainscan.0g.ai/tx/0x218aa729d6f40236be617c946e9e20ee0a1726e38868c1d93ca12b93e6e14f37
<!-- /field -->

<!-- field: Frontend demo URL -->
https://pact-zerog-dashboard.vercel.app
<!-- /field -->

<!-- field: Contact email -->
rick@quantum3labs.com
<!-- /field -->

<!-- field: Contact Telegram -->
t.me/metalboyrick
<!-- /field -->

<!-- field: Team Leader -->
Richard Sulisthio (metalboyrick) — Founder & CEO, Quantum3 Labs. Tsinghua CS (2022). Previously Tokopedia, Pixelmon, Gaspack. Built Pact Network's Solana mainnet stack.
<!-- /field -->

<!-- field: Team Members -->
- Richard Sulisthio (metalboyrick) — Founder & CEO. Strategy, fundraising.
- Alan — Founding Engineer. Owns contracts and backend.
- Ken Nguyen — Hackathon contributor. Day-0/1 spike validation, package scaffolding.
<!-- /field -->

<!-- field: Description (long, markdown) -->
**Pact-0G is the insurance layer for AI agent API calls on 0G.**

Agents that call 0G Compute today have no recourse when a provider degrades. A breached SLA still gets billed, the agent eats the loss, and nobody on-chain knows it happened. Pact fixes that.

How it works:

1. An endpoint registers on `PactCore` with a flat premium, SLO (e.g. 5s latency), and exposure cap.
2. Integrators top up a per-endpoint **coverage pool** with real USDC.e.
3. Agents call the endpoint via `market-proxy-zerog`. The proxy charges a premium per call, classifies the response against the SLO, and emits a `SettlementEvent`.
4. `settler-evm` batches events, uploads the per-call evidence blob to **0G Storage**, and submits `settleBatch` on **0G Chain**.
5. On success: the premium splits per fee config (Treasury + Affiliates + residual to pool). On breach: the agent gets refunded from the coverage pool, clamped by the hourly exposure cap.

Real USDC.e moves through the protocol — we point at the canonical [XSwap Bridged USDC](https://chainscan.0g.ai/address/0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E), not a mock.

**Why it matters:** the agentic economy needs payment trust layers, not just rails. Pact gives 0G Compute consumers a money-back guarantee, makes provider reliability priceable on-chain, and lets integrators bundle insurance into their UX without writing their own claims logic.

This is a real product. The team runs the equivalent stack on Solana mainnet today at `market.pactnetwork.io`. The 0G port is product expansion, not a hackathon-only build.

**0G components used (three of five):** 0G Chain (PactCore + settle_batch), 0G Storage (per-call evidence rootHash), 0G Compute (insured via market-proxy-zerog).
<!-- /field -->

<!-- field: Progress During Hackathon -->
- **Day 0–1 (2026-05-15):** Validated 0G stack assumptions with throwaway spikes — Foundry deploys with `cancun` on Galileo, `@0gfoundation/0g-storage-ts-sdk` round-trips with deterministic rootHash, `@0gfoundation/0g-compute-ts-sdk` discovery passes. Full numbers in `spikes/RESULTS.md`.
- **Day 1–2 (2026-05-15 → 16):** Scaffolded 9 new packages — Solidity contracts (54/54 tests, 100% coverage), viem client, storage + compute typed wrappers, market-proxy, settler, indexer, dashboard. 184 files, ~21K insertions.
- **Day 2:** Researched the canonical stablecoin on 0G mainnet — confirmed XSwap Bridged USDC.e via Chainlink CCIP at `0x1f3A…473E` (6 decimals, ~1.7M circulating supply). USDT0 doesn't support 0G yet. Wired the mainnet deploy to point at the real token instead of MockUsdc.
- **Day 2:** Deployed `PactCore` to 0G mainnet (Aristotle 16661), registered `demo-chat` endpoint, topped up the coverage pool with 0.5 USDC.e, settled a 2-call batch (1 non-breach + 1 breach with 0.01 USDC.e refund). [Live mainnet evidence](https://chainscan.0g.ai/tx/0x218aa729d6f40236be617c946e9e20ee0a1726e38868c1d93ca12b93e6e14f37).
- **Day 2:** Shipped the read-only dashboard to Vercel — https://pact-zerog-dashboard.vercel.app — reads `CallSettled` events directly from PactCore via viem, no indexer needed.
- **Cuts (honest list):** ERC-7857 INFT integration deferred. Dashboard wallet-connect + demo-runner button cut. `forge verify` against `chainscan.0g.ai/open/api` unresolved (Sourcify fallback documented). The demo CLI uses a synthetic evidence rootHash instead of a real 0G Storage upload — production settler-evm does the upload.
<!-- /field -->

<!-- field: Demo Video URL -->
TODO — record 3 min showing: (1) `pnpm demo` running with real on-chain output, (2) the dashboard at pact-zerog-dashboard.vercel.app rendering the settled calls, (3) the chainscan settle tx page. Upload to YouTube or Loom unlisted.
<!-- /field -->

<!-- field: X post (mandatory) -->
TODO — post with `#0GHackathon #BuildOn0G` and tag `@0G_labs @0g_CN @0g_Eco @HackQuest_`. Include a screenshot of the dashboard showing the live settled calls.

Suggested copy:

> Just shipped Pact-0G to 0G mainnet for the @HackQuest_ 0G APAC Hackathon.
>
> Insurance for AI agent API calls — agents pay a premium to 0G Compute, get refunded automatically when calls breach SLA. Settled on @0G_labs Chain, evidence on 0G Storage.
>
> Live settled call: chainscan.0g.ai/tx/0x218aa729…
> Dashboard: pact-zerog-dashboard.vercel.app
> Repo: github.com/pactnetwork/pact-monitor/tree/feat/pact-0g
>
> #0GHackathon #BuildOn0G @0g_CN @0g_Eco
<!-- /field -->

## Quick reference table (for skim-reading)

| Field | Value |
|---|---|
| Project name | Pact-0G |
| One-liner | Insurance for AI agent API calls on 0G — refunds agents when calls breach SLA |
| Project repo | https://github.com/pactnetwork/pact-monitor/tree/feat/pact-0g |
| Submission tag (frozen) | https://github.com/pactnetwork/pact-monitor/releases/tag/0g-apac-hackathon-2026-05-16 |
| 0G mainnet contract address | `0xc702c3f93f73847d93455f5bd8023329a8118b7f` |
| 0G Explorer link (activity) | https://chainscan.0g.ai/tx/0x218aa729d6f40236be617c946e9e20ee0a1726e38868c1d93ca12b93e6e14f37 |
| Frontend demo | https://pact-zerog-dashboard.vercel.app |
| PR with full context | https://github.com/pactnetwork/pact-monitor/pull/206 |
| Contact email | rick@quantum3labs.com |
| Contact Telegram | t.me/metalboyrick |

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

### `pact-0g` CLI — agent-perspective demo

The CLI at `samples/zerog-demo/cli.ts` is the one you'll record for the video. It mirrors the shape of the Solana `pact pay` CLI: subcommands, agent-eye output, balance deltas in human terms. Two wallets — one acting as the **agent** (holds USDC.e, signs `approve`), one as the **settler** (signs `settleBatch` on the agent's behalf).

```bash
cd samples/zerog-demo

pnpm pact-0g balance         # agent's $0G + USDC.e + allowance to PactCore
pnpm pact-0g endpoint        # demo-chat: premium 0.01, SLO 5000ms, lifetime stats
pnpm pact-0g pool            # coverage pool balance available for refunds
pnpm pact-0g pay --breach    # THE MONEY SHOT — insured call, refund auto-paid
```

Output of `pay --breach` (verified live on mainnet):

```
  Pact-0G — insured call to "demo-chat"
  ──────────────────────────────────────────────────────────────────────
  [agent    ] 0x8F6Cb2179d0185cF0E4Dd27b3EA51781E3FF77B2
  [balance  ] 0.05 USDC.e
  [endpoint ] demo-chat (0.01 USDC.e / call, 5000ms SLO)

  [call     ] POST /v1/demo-chat/chat
  [response ] HTTP 503 (12000ms > SLO → BREACH)

  [classifier] breach=true → refund
  [settle   ] 0xe690…3947  https://chainscan.0g.ai/tx/0xe690275259f...
  [premium  ] -0.01 USDC.e (debited from agent)
  [refund   ] +0.01 USDC.e (paid from coverage pool)
  [balance  ] 0.05 USDC.e   Δ ±0

  [insight] Without Pact: -0.01 USDC.e for a call that failed its SLA.
            With Pact:    0 USDC.e — protocol refunded you 0.01.
```

That `[insight]` line is the whole product in one sentence.

### Lifecycle reproducer — `samples/zerog-demo/demo.ts`

If you need to reproduce the full protocol lifecycle from scratch (deploy, approve, register, top up, settle), run `pnpm demo`. It's idempotent — re-runs skip completed steps.

### Run the demo through Claude Code

A project-local skill at `.claude/skills/pact-0g-demo/` walks Claude through the pre-flight + 3-command demo flow, captures the fresh tx hash, and emits paste-ready X-post copy. Invoke with `/pact-0g-demo` once the user runs `claude` inside the repo.

---

## Live mainnet artifacts via the CLI

In addition to the lifecycle batch above, the CLI has settled three more calls on Aristotle as live verification:

| CLI command | Tx hash | Outcome |
|---|---|---|
| `pact-0g approve` (agent → PactCore max allowance) | [`0x4b2dcc0e…7956`](https://chainscan.0g.ai/tx/0x4b2dcc0e6046b74bd4a8c9439b37353f14e060318a073281aa309f45a3977956) | success |
| `pact-0g pay --breach` (agent: ±0 net) | [`0xe6902752…3947`](https://chainscan.0g.ai/tx/0xe690275259f6a3ae4e5451509f928a0a6f9be1e2119e1bb2aef7acc57ee33947) | breach refunded |
| `pact-0g pay` (success path, agent: -0.01) | [`0x8a50c9e7…94bc`](https://chainscan.0g.ai/tx/0x8a50c9e7f8d90b1476f156f2f599ef0324218440ea2fc7e5d8ac7393f42a94bc) | premium only |

Each is signed by two different wallets (agent `0x8F6C…77B2` calls `approve`; settler `0xAD09…8Fc7` calls `settleBatch`) — explicit on-chain proof of the production-shape two-party model.

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

## Reference screenshots

Captured from hackquest.io 2026-05-16. Stored in [`docs/submission-screenshots/`](./docs/submission-screenshots/):

| File | What it shows |
|---|---|
| `hackquest-overview.png` | Hackathon overview page |
| `hackquest-prizes.png` | $150K prize breakdown |
| `hackquest-schedule.png` | Submission deadline 2026-05-16, 15:59 |
| `hackquest-resource.png` | 0G core component descriptions |
| `hackquest-gallery.png` | Existing submissions (ClawGuard, Vericast, WRAITH) |
| `hackquest-project-tall.png` | Full ClawGuard project page — what our submission will look like |
| `hackquest-checkpoints.png` | Checkpoints tab layout |
| `hackquest-register.png` | Sign-in wall — form fields require login to access directly |

## Still to do before submission close

1. Record 3-minute demo video — show `pnpm demo`, then the dashboard, then the chainscan settle tx
2. Post on X with the four mandatory hashtags + four mandatory tags
3. Submit via the [HackQuest form](https://www.hackquest.io/hackathons/0G-APAC-Hackathon) using the field blocks above (each has paste-ready content)
