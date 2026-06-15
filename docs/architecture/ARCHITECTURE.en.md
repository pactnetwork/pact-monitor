# Pact Network — Architecture Overview (EN)

> Generated 2026-06-02, updated 2026-06-03 (off-chain V2 removed) from the `feat/multi-network` branch, grounded in the GitNexus code graph (1,756 files / 16,841 symbols / 251 execution flows) and the live workspace layout. Diagrams are Mermaid (render on GitHub).

---

## 1. What this project is

**Pact Network is an on-chain risk layer for AI-agent API payments.** For each insured API endpoint the protocol holds a coverage pool, debits a small premium from the agent's stablecoin balance on every call, and automatically refunds the agent when a call breaches an SLA (latency, 5xx, network error). Every settlement is on-chain, with explicit per-recipient fee splits: most of the premium stays in the pool, a configurable cut goes to the network treasury, and another cut goes to the integrator who registered the endpoint.

The codebase separates cleanly into **two products**:

| Product | What it is | Surface |
|---------|------------|---------|
| **Pact Network** | The generic *rails* — on-chain programs (Solana + EVM), the multi-VM abstraction, wrap libraries, settler, indexer, shared types, DB schema. Anyone can build on it. | npm packages + on-chain programs |
| **Pact Market** | *One opinionated interface* on top of the rails — a hosted proxy wrapping curated providers (Helius, Birdeye, Jupiter, Elfa, fal.ai) + a dashboard. | `market.pactnetwork.io`, `dashboard.pactnetwork.io` |

```mermaid
graph TD
    subgraph Market["PACT MARKET — one interface on top of the rails"]
        MP[market-proxy<br/>Hono / Cloud Run]
        MD[market-dashboard<br/>Next.js 15]
    end
    subgraph Network["PACT NETWORK — the generic rails"]
        WRAP[wrap<br/>fetch-call insurance]
        SHARED[shared<br/>ChainAdapter port + types]
        SET[settler<br/>settle_batch submitter]
        IDX[indexer<br/>ingest + read API + refunds]
        DB[(db<br/>Postgres / Prisma)]
        CLIENTS[protocol-v1-client<br/>protocol-evm-v1-client]
    end
    subgraph Chains["ON-CHAIN"]
        SOL[Solana Pinocchio<br/>pact-network-v1]
        EVM[EVM Solidity<br/>Pool + Settler + Registry]
    end
    AGENT[AI Agent] --> MP
    MP --> WRAP
    WRAP --> SHARED
    SET --> SHARED
    IDX --> SHARED
    SHARED --> CLIENTS
    CLIENTS --> SOL
    CLIENTS --> EVM
    SET --> SOL & EVM
    IDX --> DB
    MD --> IDX
```

---

## 2. The multi-VM seam (the heart of the current architecture)

The defining feature of the current `feat/multi-network` branch is a **ports-and-adapters (hexagonal)** design that lets the off-chain fleet speak to Solana *and* EVM chains (Arc, Base) through one interface.

- **Port:** `ChainAdapter` (`packages/shared/src/chain-adapter.ts`) — `ChainVm = "solana" | "evm"`.
- **Adapters:** `SolanaAdapter` (`packages/shared/src/adapters/solana/`) and `EvmAdapter` (`packages/shared/src/adapters/evm/`).
- **Consumers:** settler (`submitSettleBatch`), indexer (`adapters.service.ts`, `tailSettlementEvents`), market-proxy (`lib/balance.ts`, eligibility checks).

```mermaid
graph LR
    subgraph Consumers
        SET[settler]
        IDX[indexer]
        MP[market-proxy]
    end
    PORT{{ChainAdapter port<br/>readEndpointConfigs · getEndpoint<br/>submitSettleBatch · getNativeBalance<br/>checkAgentEligibility · tailSettlementEvents}}
    SET --> PORT
    IDX --> PORT
    MP --> PORT
    PORT --> SOL[SolanaAdapter] --> SOLP[Pinocchio program<br/>protocol-v1-client]
    PORT --> EVMA[EvmAdapter] --> EVMP[3-contract Solidity<br/>protocol-evm-v1-client]
```

`ChainAdapter` exposes: `readEndpointConfigs` / `readEndpointConfigsFrom`, `getEndpoint`, `submitSettleBatch`, `getNativeBalance`, `checkAgentEligibility`, `tailSettlementEvents`. To add a new chain you implement one adapter — the settler/indexer/proxy code is chain-agnostic.

---

## 3. Package inventory

The monorepo is pnpm + Turborepo. 19 packages (after removing the 5 off-chain V2 packages on 2026-06-03), grouped by layer:

### On-chain programs
| Package | Role |
|---------|------|
| `program/programs-pinocchio/pact-network-v1-pinocchio` | **Solana v1** (Pinocchio): agent prepaid wallet via SPL approval, per-endpoint pools, fee recipients, pool-as-residual settlement |
| `program/programs-pinocchio/pact-network-v2-pinocchio` | Solana v2 (future): multi-underwriter parametric insurance + claims |
| `program-evm/protocol-evm-v1` | **EVM v1** (Solidity): 3-contract set — `PactPool`, `PactSettler`, `PactRegistry` |
| `program/programs/pact-insurance` | LEGACY Anchor crate — rollback fallback only, do not modify |

### Protocol clients (TS)
| Package | Role |
|---------|------|
| `protocol-v1-client` | TS client for Solana v1 (PDAs, ix builders, account decoders, error map) |
| `protocol-evm-v1-client` | TS client for EVM v1 (abi, addresses, encode, state, errors) |

### Rails — generic off-chain
| Package | Role |
|---------|------|
| `shared` | **Multi-VM abstraction** (`ChainAdapter`, adapters), shared types, PDA seed constants |
| `wrap` | Generic fetch-call insurance (`wrapFetch`, BalanceCheck, Classifier, EventSink, X-Pact-* headers) |
| `settler` | Pub/Sub → `settle_batch` submitter (NestJS) |
| `indexer` | Per-call indexer + read API + refund delivery + reorg handling (NestJS) |
| `db` | Prisma schema (pool state, settlements, recipient shares, earnings) |

### Pact Market — the interface
| Package | Role |
|---------|------|
| `market-proxy` | Hono proxy wrapping curated providers; consumes `wrap` |
| `market-dashboard` | Next.js 15 dashboard (App Router, Tailwind 4, wallet-adapter) |

### Client / SDK / tooling
| Package | Role |
|---------|------|
| `sdk` | Agent-side SDK (createPact, golden-fetch, Solana+EVM signing). *Merchant surface is in open PR #223 (`feat/merchant-sdk`), not merged into this branch.* |
| `cli` | `pact-cli` — operator + agent command line |
| `facilitator` | x402-style payment facilitator |
| `monitor` / `insurance` | Pre-Step-A SDKs (reliability monitor, legacy v2 insurance) |
| `backend` | **Live Market control-plane** (Fastify): private beta gate, self-serve API-key issuance, faucet, partners/CRM — `market-proxy`'s beta-gate validates keys issued here, so it is release-critical. Also still hosts the legacy public scorecard (providers/records/analytics) and V2 claims (`pools.ts` + cranks are the only `insurance`-coupled part). |
| `scorecard` | Legacy public-scorecard frontend (Vite/React) — calls `backend` over HTTP. |
| `dummy-upstream` | Keyless test upstream for smoke tests |

---

## 4. Package dependency & reuse

The 19 packages (after removing the 5 off-chain V2 packages on 2026-06-03) split into a **server backbone** (settler/indexer/proxy on `shared` + `wrap` + clients) and a set of **client-side / standalone packages** (the published SDK, CLI, legacy SDKs). Edges are real internal deps from each `package.json` — `dependencies` **and** `devDependencies` (bundled packages like the CLI declare workspace deps under `devDependencies` because `bun build` inlines them).

```mermaid
graph TD
    subgraph leaf["Leaf layer — no internal deps"]
        P1[protocol-v1-client]
        PE[protocol-evm-v1-client]
        W[wrap]
        DB[(db)]
    end
    subgraph hub["Multi-VM hub"]
        SH[shared]
    end
    subgraph svc["Services — GOOD REUSE"]
        SET[settler]
        IDX[indexer]
        MP[market-proxy]
        MD[market-dashboard]
        FAC[facilitator]
    end
    subgraph client["Client SDK / CLI — own EVM path via viem"]
        SDK["sdk · viem: Solana+EVM"]
        CLI["cli · viem: Solana+Arc+Base"]
    end
    subgraph legacy["Standalone legacy SDKs"]
        MON[monitor]
        INS[insurance]
        BE[backend]
    end
    SH --> P1 & PE & W
    SET --> SH & W & P1 & PE
    IDX --> SH & DB & P1 & PE
    MP --> SH & W & PE
    MD --> P1
    FAC --> W
    SDK --> P1
    CLI --> P1 & MON
    BE --> INS
```

- **Server backbone:** settler/indexer/market-proxy route through `shared` + `wrap` + protocol clients. Adding a chain or service reuses this layer.
- **Client SDK/CLI are multi-network, by their own path:** `sdk` + `cli` depend on `protocol-v1-client` and use **`viem`** for EVM. The **CLI supports Solana + Arc + Base** (`lib/evm-wallet.ts`, `lib/evm-faucets.ts`, `cmd/run.ts` branch on `isEvmNetwork`); the SDK signs for Solana + EVM. They deliberately do **not** use the server-side `shared` layer (settle-submission / RPC tailing) — correct layering for a client runtime, not divergence. (CLI deps live in `devDependencies` because it is bundled via `bun build`.)
- **Standalone legacy:** `monitor` and `insurance` have 0 internal deps (pre-Step-A public SDKs).
- **Genuine duplication to watch:** the SLA status→category classifier has one true copy-paste (`backend/routes/monitor.ts:24`, a copy of `monitor`'s tree), and `wrap`'s premium/refund economics are duplicated in `facilitator/coverage.ts`. The "two V2 Solana clients" issue is now half-resolved — `protocol-v2-client` was deleted on 2026-06-03, leaving `insurance` as the sole V2 client.

> Technical-debt detail + unification plan: see **`DIVERGENCE-AUDIT.en.md`**.

---

## 5. Layered architecture

```mermaid
graph TD
    subgraph L5["Clients"]
        A[AI Agent + Pact SDK]
        OP[Operator / Integrator + CLI]
        DASH[Dashboard user]
    end
    subgraph L4["Edge / Interface"]
        PROXY[market-proxy<br/>Hono]
        DASHBE[market-dashboard<br/>Next.js]
    end
    subgraph L3["Insurance logic"]
        WRAP2[wrap<br/>premium math · balance check · classifier]
    end
    subgraph L2["Off-chain services"]
        SETTLER[settler<br/>Pub/Sub consumer]
        INDEXER[indexer<br/>ingest · read API · refund delivery · reorg]
        PG[(Postgres / Prisma)]
    end
    subgraph L1["Multi-VM abstraction"]
        ADAPT[shared: ChainAdapter + Solana/EVM adapters + clients]
    end
    subgraph L0["On-chain"]
        SOLANA[Solana Pinocchio v1]
        EVMC[EVM 3-contract set]
    end
    A --> PROXY --> WRAP2 --> ADAPT
    OP --> PROXY
    DASH --> DASHBE --> INDEXER
    WRAP2 -. emits settlement events .-> SETTLER
    SETTLER --> ADAPT
    INDEXER --> ADAPT
    ADAPT --> SOLANA & EVMC
    INDEXER --> PG
    SETTLER -. /events .-> INDEXER
```

---

## 6. Core runtime flows (with real code anchors)

### Flow A — Insured API call (premium debit + classification)
```mermaid
sequenceDiagram
    participant Agent
    participant Proxy as market-proxy<br/>proxyRoute
    participant Wrap as wrap<br/>wrapFetch
    participant Adapter as ChainAdapter
    participant Upstream as Upstream API
    Agent->>Proxy: ALL /v1/:slug/*
    Proxy->>Wrap: wrapFetch(opts)
    Wrap->>Adapter: checkAgentEligibility / getNativeBalance
    Wrap->>Wrap: attachPactHeaders (X-Pact-*)
    Wrap->>Upstream: forward request
    Upstream-->>Wrap: response
    Wrap->>Wrap: classify outcome (OK / breach)
    Wrap-->>Proxy: response + settlement event
```
Anchors: `proxyRoute` (`market-proxy/src/routes/proxy.ts:25`), `wrapFetch` (`wrap/src/wrapFetch.ts:60`), `attachPactHeaders` (`wrap/src/headers.ts:45`), balance `check` (`wrap/src/balanceCheck.ts:152`, `market-proxy/src/lib/balance.ts:63`).

### Flow B — Settlement (on-chain debit + fee split + refund)
```mermaid
sequenceDiagram
    participant Queue as Pub/Sub
    participant Settler as settler<br/>PipelineService
    participant Adapter as ChainAdapter<br/>submitSettleBatch
    participant Chain as Solana / EVM
    participant Indexer as indexer<br/>EventsService.ingest
    participant DB as Postgres
    Queue->>Settler: settlement events (batch)
    Settler->>Adapter: submitSettleBatch(SettleBatchInput)
    Adapter->>Chain: settle_batch (premium to pool/treasury/integrator, refund on breach)
    Chain-->>Adapter: SettleBatchResult (tx sig)
    Settler->>Indexer: POST /events
    Indexer->>DB: persist settlement + recipient shares
    Indexer->>Indexer: RefundDeliveryService / ReorgService
```
Anchors: `PipelineService` (`settler/src/pipeline/pipeline.service.ts:8`), `SettleBatchInput` (`shared/src/chain-adapter.ts:58`), `EventsService.ingest` (`indexer/src/events/events.service.ts:70`), `RefundDeliveryService` (`indexer/src/refund-delivery/refund-delivery.service.ts:18`), `ReorgService.rollback` (`indexer/src/reorg/reorg.service.ts:143`).

---

## 7. Tech stack

| Concern | Choice |
|---------|--------|
| Language | TypeScript (off-chain), Rust/Pinocchio 0.10 (Solana), Solidity (EVM) |
| On-chain Solana | Pinocchio program, devnet `5jBQb7fL…`, mainnet `5bCJ…` |
| On-chain EVM | 3-contract Solidity (Pool/Settler/Registry) on Arc Testnet + Base Sepolia |
| Proxy | Hono on Cloud Run (Node 22) |
| Services | NestJS on Cloud Run, Pub/Sub queue, Cloud SQL Postgres |
| Dashboard | Next.js 15 (App Router), Tailwind 4, shadcn/ui, wallet-adapter |
| Solana client | `@solana/web3.js` 1.x, `@solana/kit` 2.x, hand-written decoders |
| Tooling | pnpm workspaces, Turborepo, Vitest, LiteSVM (Bun), surfpool, Foundry (EVM) |

---

## 8. Deployment topology

```mermaid
graph LR
    subgraph CloudRun["Google Cloud Run"]
        P[market-proxy<br/>market.pactnetwork.io]
        I[indexer<br/>indexer.pactnetwork.io]
        S[settler]
        D[market-dashboard<br/>dashboard.pactnetwork.io]
    end
    PUBSUB[(Pub/Sub)]
    SQL[(Cloud SQL<br/>Postgres)]
    SM[Secret Manager]
    P -. settlement events .-> PUBSUB --> S
    S --> SQL
    I --> SQL
    S -. /events .-> I
    D --> I
    S --- SM
    P --- SM
```

GCP ownership note: Secret Manager / Cloud Run / IAM are owned by Rick; on-chain ops (program deploy, authority) are split out as a separate runbook.

---

## 9. Current state (2026-06-03)

- **Off-chain V2 stack removed 2026-06-03 (commit 2b5cb0c)** — `wrap-v2`, `settler-v2`, `indexer-v2`, `db-v2`, `protocol-v2-client` source deleted (the on-chain `pact-network-v2-pinocchio` Rust program is kept).
- **Active branch:** `feat/multi-network` — multi-VM rails (Solana + Arc Testnet + Base Sepolia), CLI/SDK headers. PR #225 awaiting re-review.
- **Merchant SDK** (PR #223, branch `feat/merchant-sdk`) rebased onto this branch with tests green, but **not yet merged** — the merchant surface is not in this tree.
- **Mainnet:** Solana program `5bCJ…` live; redeploy via authority `JB7rp…` pending (unblocks SOL-01 + the FS9 `InvalidSeeds` devnet drift).
- **Known constraints:** devnet program `declare_id!` == mainnet id → `settle_batch` reverts `InvalidSeeds` on devnet until redeploy.

---

## 10. Where to look next

| Goal | Start at |
|------|----------|
| Add a new EVM chain | `shared/src/adapters/evm/`, `program-evm/protocol-evm-v1/`, endpoints catalog |
| Add a curated provider | `market-proxy/src/routes/proxy.ts`, on-chain `register-endpoint` |
| Understand settlement | `shared/src/chain-adapter.ts` → `settler/src/pipeline/` |
| Understand indexing/refunds | `indexer/src/events/events.service.ts`, `indexer/src/refund-delivery/` |
| On-chain Solana logic | `program/programs-pinocchio/pact-network-v1-pinocchio/src/` |
| On-chain EVM logic | `program-evm/protocol-evm-v1/src/` (Pool/Settler/Registry) |
