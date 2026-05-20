# Pact Multi-Network — Off-Chain Services Spec (proxy / settler / indexer)

- **Date:** 2026-05-19
- **Status:** DRAFT — companion to `docs/evm/2026-05-19-multi-network-architecture-spec.md` (the "architecture spec"); REV1 hardened; **architecture §11 decisions LOCKED 2026-05-20**; §10 below reflects the locked state
- **Scope:** the three off-chain services on the settlement path — `market-proxy` (the request-path server), `settler`, `indexer`. Contracts/clients/adapters are specified in the architecture spec; this doc specifies how the services consume them.
- **Decision inherited (LOCKED):** one chain abstraction, not fork-per-chain; Arc 3-contract set canonical; 0G `PactCore` retired (architecture spec §0).
- **Evidence base:** verified against `packages/market-proxy/src`, `packages/settler/src`, `packages/indexer/src`, `packages/wrap/src` on `feat/arc-protocol-v1`.
- **External (not in this tree):** Ken's Agent SDK draft = `~/Downloads/SDK Design - Pact Network/Pact Agent SDK — Design Draft.html` (external artifact, never committed); EVM-expansion design = `docs/evm/2026-05-15-evm-expansion-design.md` on branch `origin/feat/evm-expansion-design` (PR #201), NOT on this branch.

> **REV1 (2026-05-19, post independent review):** corrected against ground truth — §2.2 `SettlementEvent` v2 rewritten to the real `wrap/src/types.ts` shape (was speced against a non-existent shape); §5 indexer rewritten (the per-call path is PUSH, not chain-sync; `backfill`/`webhook` are stubs); +§5a dashboard/frontend; +§2.5 per-VM auth/secrets; +§2.6 reorg/finality; §8 phases aligned to the architecture spec's P-numbering. See the review coverage matrix.

---

## 1 · The pipeline

```
 agent ──HTTP──> market-proxy ──SettlementEvent──> queue ──> settler ──settle tx──> CHAIN(network)
   (server: classify, premium intent, publish)                 (batch, sign, submit)      │
                                                                                          │ events/accounts
                          indexer.read API / ops / dashboard <── DB(Postgres) <── indexer.sync ◄┘
```

Three chain-touch surfaces. Each is **narrow** and **two of the three required interfaces already exist** (`wrap.BalanceCheck`, `wrap.EventSink`, `settler.QueueConsumer`). This spec adds one more interface (`ChainAdapter`, from the architecture spec) and one contract change (`SettlementEvent` gains `network`).

## 2 · Cross-cutting design

### 2.1 Precedent: this move is already accepted twice

| Existing interface | Impls | Proves |
|---|---|---|
| `wrap` `EventSink` | `HttpEventSink`, `PubSubEventSink`, `RedisStreamEventSink` | publish backend is swappable behind an interface |
| `wrap` `BalanceCheck` | lazy Solana resolver (`market-proxy/lib/balance.ts`, dynamic `@solana/web3.js` import) | the chain balance read is *already* an interface + lazy impl |
| `settler` `QueueConsumer` | `PubSubQueueConsumer`, `RedisStreamsQueueConsumer` | the team already does interface+per-env impls for infra variance |

`ChainAdapter` (architecture spec §3 L2) is the same move applied to submit/read/decode. The argument to Rick: *"do for the chain what `wrap` and the settler already did for balance, events, and the queue."*

### 2.2 The one contract change — `SettlementEvent` `+network` (verified against real shape)

The **actual** wire `SettlementEvent` (`packages/wrap/src/types.ts`) is:

```ts
// CURRENT — packages/wrap/src/types.ts (verified)
export interface SettlementEvent {
  callId: string;
  agentPubkey: string;        // base58 today; opaque string (0x on EVM)
  endpointSlug: string;
  premiumLamports: string;    // decimal STRING, base units of the settlement mint
  refundLamports: string;     // decimal STRING
  latencyMs: number;
  outcome: Outcome;           // NOT a boolean — "ok" | "latency_breach" | "server_error" | "network_error" | "client_error"
  ts: string;                 // ISO STRING
  // …existing optional fields (pay.sh payee/resource) unchanged…
}
```

**The only change is additive — one new field:**

```ts
  network: string;            // NEW, required — registry key, e.g. "arc-testnet"
```

Explicitly **NOT** doing what an earlier draft proposed (it was wrong):

- **Do not rename `premiumLamports`/`refundLamports`.** They are decimal *strings* (not `bigint`), already in base units of the settlement mint. Renaming breaks the wire/header contract and the type is misstated as `bigint`. Keep the names; document that "lamports" here means "base units of the network settlement mint" (USDC is the 6-dec invariant on every network).
- **Do not collapse `outcome` → `breach: boolean`.** It is **lossy**: `indexer/src/events/events.dto.ts` documents the projection `outcome → breach + breachReason` (`latency_breach`/`server_error`/`network_error` → covered breach with reason; `client_error` → premium=0, dropped). Breach classification is an **indexer-side** projection and MUST stay there. The wire keeps `outcome`.

`network` is the routing key end-to-end: proxy stamps it → queue keyed by it → settler resolves the adapter from it → indexer writes it to the DB. Backward-compatible: `network` is optional for one release (consumers default absent → `solana-mainnet`), then required once all consumers read it. No value semantics change.

Note there are **three distinct "SettlementEvent"-named shapes** and the architecture spec's `ChainAdapter.settleBatch` consumes the **wire** one above: (1) wire/queue (this), (2) indexer batch-ingest DTO `SettlementEventDto{ signature, batchSize, calls: WrapCallEventDto[] }` (push contract, §5), (3) on-chain instruction args (`protocol-v1-client` / EVM client). The adapter owns the wire→on-chain projection that lives in `SubmitterService.submit()` today (EndpointConfig snapshot, Treasury vault, fee-share computation, callId parsing).

### 2.3 Registry resolution (uniform)

Every service resolves its chain context the same way: `NETWORK` env → `NETWORKS[network]` (`NetworkDescriptor`, architecture spec §3 L3) → `resolveAdapter(network)` (the `chain-adapters` package). No service constructs a `Connection`/`viem` client directly after this refactor.

### 2.4 Runtime model — fleet-per-network (DECISION, recommended)

One deployment **per network** per service, same image, `NETWORK` env selects the adapter. **Not** one process multiplexing N networks.

| | Fleet-per-network (chosen) | Single multi-network process |
|---|---|---|
| Failure isolation | a Solana RPC outage cannot stall Arc settlement | shared failure domain |
| Signer keys | one signer per deployment (clean secret scoping) | N signing keys in one process |
| Gas/health semantics | per-network thresholds, per-network gauges | conditional logic per message |
| Matches today | yes — devnet (Redis) vs mainnet (Pub/Sub) are already separate deployments | no |

The **DB is the single shared multi-network store** (one schema + `network` column, architecture spec §6). So read API / stats / dashboard are unified across all networks even though the write-path fleets are isolated. Queues/topics are **per-network** (`pact-settle-<network>`).

### 2.5 Per-VM auth, secrets & rotation

Identity and signatures are VM-specific and currently Solana-only:

| Concern | Solana today | EVM target | Spec'd action |
|---|---|---|---|
| Settler signer secret | `Keypair` JSON via `secret-loader` | hex private key (or KMS) | `adapter` owns signer type; secret id keyed by network; one secret per fleet |
| Signer rotation | upgrade-authority rotation is a flagged mainnet blocker (CLAUDE.md) | EOA key rotation (re-grant `SETTLER_ROLE`, no contract change) | per-VM rotation runbook; EVM rotation = grant/revoke `SETTLER_ROLE` to a new EOA |
| Operator (ops) signature verify | `nacl.sign.detached.verify` + bs58 (ed25519), `indexer/ops` | ECDSA / EIP-191 / EIP-4361 (SIWE) | `adapter.verifyOpsSignature(vm, …)`; ops payload + verify scheme per VM |
| Allowlist identity columns | `OperatorAllowlist.walletPubkey @db.VarChar(44)`, `DemoAllowlist` — sized for base58 | 0x addresses (42 chars) differ | widen/normalize columns; add the `network` column these tables also lack |

This is net-new for EVM (no ECDSA ops-verify path exists) — not a refactor.

### 2.6 Reorg / finality / idempotency (correctness-critical)

Solana settlement uses CallRecord-PDA existence for on-chain idempotency; the indexer push-path keys idempotency on `signature` + `callId` (`EventsService.ingest`, Prisma P2002). EVM has no PDA analogue and reorgs can replay a tx under a **different** tx hash:

- Settler/adapter MUST act on **finalized** commitment only per VM (Solana `finalized`; EVM finality/safe-block depth per chain, from `NetworkDescriptor`).
- The indexer idempotency key must be **chain-stable**: use `(network, callId)` as the dedup key, NOT `signature` (which changes across an EVM reorg). The on-chain `DuplicateCallId` guard (locked, both VMs) is the backstop.
- Reorg rollback of already-ingested `Settlement`/`PoolState` rows: define a per-VM reorg depth and a compensating-rollback path before the EVM fleet goes live. Unspecified today; greenfield.

---

## 3 · Service A — `market-proxy` (the server)

### 3.1 Current architecture

Hono proxy. `routes/proxy.ts` wraps the upstream call via `@pact-network/wrap` `wrapFetch`; `lib/context.ts` builds the per-request context with a `BalanceCheck` + `EventSink`; on a covered call it publishes a `SettlementEvent` via `lib/events.ts` (`createPubSubSink`).

### 3.2 Chain-coupled seams (verified)

| File | Coupling | Disposition |
|---|---|---|
| `lib/balance.ts` | lazy `import("@solana/web3.js")` + `@solana/spl-token`; computes USDC ATA balance | already behind `wrap.BalanceCheck` + already lazy → becomes one of N `BalanceCheck` impls selected by `descriptor.vm` |
| `lib/events.ts` | `createPubSubSink(project, topicName)` | already `wrap.EventSink`; topic name becomes `pact-settle-<network>` |
| `lib/context.ts` | `usdcMint: env.USDC_MINT` | replaced by `descriptor.usdc` from the registry |
| `env-schema.ts` | single `USDC_MINT` | replaced by `NETWORK` → registry |

This is the **least-coupled** service — the chain read is already an interface and already lazy-imported.

### 3.3 Target design

- `lib/balance.ts` → `chain-adapters` provides `makeBalanceCheck(descriptor)`: Solana impl = current resolver; EVM impl = `viem` `balanceOf(usdc, agent)`. Same `wrap.BalanceCheck` interface; proxy picks by `descriptor.vm`.
- Proxy stamps `event.network = descriptor.network` before `sink.publish` (and into the `X-Pact-*` response headers for the SDK).
- `EventSink` publishes to the per-network topic/stream resolved from the descriptor.
- One proxy deployment per network (or one proxy front, per-network sink selected by the matched endpoint's `network` — see §3.4).

### 3.4 Open sub-decision (proxy-specific)

A single curated Pact Market proxy may front endpoints on **multiple** networks (a Helius pool on Solana, an Arc-native endpoint on Arc). Two options:

- **A — proxy is single-network** (fleet-per-network, consistent with §2.4): an endpoint is reachable only via its network's proxy deployment. Simplest, matches the rest of the pipeline.
- **B — proxy is multi-network at the edge**, per-request: the matched endpoint's `network` (from `lib/registry.ts` / endpoint config) selects the `BalanceCheck` + sink for that request; settle path downstream is still per-network via the `network` field.

Recommendation: **B for the proxy only** (the proxy is stateless, holds no signer, does no on-chain write — multi-network at the edge is cheap and better UX for a curated marketplace), **A for settler + indexer** (stateful, signer-holding, RPC-sensitive). The `network` field makes them composable: edge picks network, the write fleets stay isolated.

---

## 4 · Service B — `settler`

### 4.1 Current architecture

NestJS. `consumer/` (QueueConsumer: Pub/Sub | Redis Streams) → `batcher/` → `pipeline/` → `submitter/` (build + sign + send `settle_batch`) → `indexer/indexer-pusher` (push result to indexer). `health/signer-balance` gates readiness on signer balance.

### 4.2 Chain-coupled seams (verified)

| File | Coupling | Disposition |
|---|---|---|
| `submitter/submitter.service.ts` | builds/signs/sends `settle_batch` (Solana Keypair + blockhash) | → `adapter.settleBatch(events)`; Solana (Keypair, recent blockhash, confirm) vs EVM (EOA key, nonce, gas, receipt) hidden in the impl |
| `health/signer-balance.service.ts` | `@solana/web3.js Connection.getBalance`; **SOL** thresholds 0.01/0.003; gauge `settler_signer_sol_lamports` | **must become per-network**: Arc gas = USDC (6-dec), other EVM = ETH (18-dec); thresholds, decimals, and gauge name come from `descriptor` (`adapter.signerGasBalance()` + `descriptor.gasAsset`) |
| `config/env.ts` | `SOLANA_RPC_URL`, `PROGRAM_ID` default `5jBQb7…`, `USDC_MINT?` | replaced by `NETWORK` → registry; `PROGRAM_ID`/addresses come from the deployment address-book |
| `config/secret-loader.service.ts` | loads a Solana `Keypair` | per-network signer; `adapter` owns the signer type (Keypair vs hex privkey); secret id keyed by network |

Chain-agnostic, unchanged: `consumer`, `batcher`, `pipeline`, `indexer-pusher`, `metrics` (gauge name parameterised).

### 4.3 Target design

- `submitter` depends only on `ChainAdapter`. `adapter.settleBatch(SettlementEvent[])` returns a normalized `TxRef { network, hash/sig, status, blockOrSlot }`.
- `signer-balance` → `adapter.signerGasBalance()` returning `{ asset, decimals, amount }`; thresholds defined per-network in the registry (`descriptor.signerWarn`, `descriptor.signerCrit`), expressed in that network's gas asset. The current 0.003-SOL hard floor and `_sol_lamports` gauge name are **wrong on Arc** — this is a correctness fix, not cosmetic. Gauge becomes `settler_signer_gas_baseunits{network,asset}`.
- One settler deployment per network: `NETWORK=arc-testnet`, its own queue subscription `pact-settle-arc-testnet`, its own signer secret, its own RPC. Image identical across networks.
- Batching stays per-network (a batch is one `settle_batch`/`settleBatch` tx on one chain — never mixed).

### 4.4 Settler-specific risks

- **R-S1** Solana `settle_batch` accounts list vs EVM `settleBatch(events[])` calldata differ structurally — the adapter must own batch encoding, not the submitter. Mitigate: `adapter.settleBatch` takes the decoded `SettlementEvent[]`; encoding is the impl's job (already true for the EVM client per WP-EVM parity work).
- **R-S2** gas exhaustion semantics differ (SOL rent/fee vs Arc USDC-gas vs ETH). Mitigate: per-network thresholds from registry; fail-closed readiness unchanged.
- **R-S3** dedup/idempotency: a redelivered queue message must not double-settle across a fleet restart. Unchanged from today (callId dedup is on-chain + DB), but the DB watermark must now be keyed `(network, callId)`.

---

## 5 · Service C — `indexer`

### 5.1 Current architecture (verified — corrects an earlier wrong model)

**The per-call settlement data path is PUSH, not chain-sync.** Verified:

- `events/` — `POST /events`, `EventsService.ingest(SettlementEventDto{ signature, batchSize, calls: WrapCallEventDto[] })`: the **settler pushes** every settled batch; this is how `Call`/`Settlement`/`SettlementRecipientShare`/`RecipientEarnings`/`PoolState` rows are written. Idempotency keyed on `signature` + `callId` (Prisma P2002).
- `sync/on-chain-sync.service.ts` — does **only** a config refresh: a `@Cron(EVERY_5_MINUTES)` job that `getProgramAccounts` all `EndpointConfig` PDAs and upserts the `Endpoint` table. **No slot cursor, no per-call sync, no event tailing.** (`lazy-create` in `EventsService.ingest` is the safety net.)
- `backfill/backfill.module.ts` — **a 1-line TODO stub.** `webhook/parser.service.ts` — **a 9-line stub** returning `{received:true}`.

So the earlier claim "indexer just needs a `network` column, `adapter.watch()` symmetric Solana/EVM" was **wrong**: there is no Solana per-call event-sync to wrap.

### 5.2 Chain-coupled seams (verified)

| File | Reality | Disposition |
|---|---|---|
| `events/events.service.ts` (ingest) | **chain-agnostic already** — consumes the wire push DTO | only needs `+network` on the DTO (§2.2) + the DB `network` column. No adapter. |
| `sync/on-chain-sync.service.ts` | `getProgramAccounts` + `decodeEndpointConfig` (Borsh) — **config refresh only** | → `adapter.readEndpointConfigs()`: Solana = PDA scan + Borsh; EVM = registry read / `getLogs(EndpointRegistered/Updated)`. Per-VM, but it is a **config snapshot**, not a per-call cursor. |
| `ops/ops.service.ts` | builds an unsigned ops envelope; today a base64 JSON with a `TODO(layered-phase1)` — **not a real Solana tx yet** | → `adapter.buildUnsignedOps*()` per VM. This is **greenfield**, not a refactor (the real tx-build is unimplemented even for Solana). |
| `backfill/`, `webhook/` | **stubs** (1 / 9 lines) | greenfield on every chain; EVM may need an `adapter.tailSettlementEvents(fromBlock)` for reconciliation — see §5.3. Not required for v1 multi-network. |

Chain-agnostic, only need `network`: `api/` (agents/calls/endpoints), `stats/`, `prisma/`, `guards/`, and the `events/` ingest itself.

### 5.3 Target design (corrected)

- **EVM reuses the PUSH model.** A `settler` fleet for an EVM network pushes the same `/events` contract (`+network`) → same `EventsService.ingest` → same DB, network-tagged. This is precisely what the 0G fork's separate `settler-evm` + `indexer-evm` reinvented; the unification is **one push contract + `network` field**, NOT a log-tail. The indexer ingest tier stays a single shared multi-network deployment.
- **Config refresh becomes `adapter.readEndpointConfigs()`** — one `sync` deployment per network (Solana PDA scan vs EVM read). The result upserts the shared `Endpoint` table with `network`.
- **`ops`** → `adapter.buildUnsignedOps*()` returning `{ network, vm, unsigned }`; signing is per-VM in the dashboard (§5a). Note this path is unimplemented today (Solana included) — it is new work, gated, not a port.
- **Backfill/reconciliation** (EVM only, future): an optional `adapter.tailSettlementEvents(fromFinalizedBlock)` reading `CallSettled` logs to repair a missed push. Greenfield; explicitly **post-v1**, not on the multi-network critical path. Solana has no equivalent and stays push-only.
- DB rows carry `network`; read API/`stats` aggregate across networks, filter `?network=`.

### 5.4 Indexer-specific risks

- **R-I1** Push-gap: if a settler push is lost, Solana has no recovery path today (no backfill). Multi-network does not worsen this, but EVM's optional `tailSettlementEvents` (§5.3) is the only proposed repair — flag that backfill is an unsolved pre-existing gap on Solana too.
- **R-I2** Idempotency under EVM reorg: `signature`-keyed dedup breaks (tx hash changes on replay). Use `(network, callId)` (see §2.6). Backstop: on-chain `DuplicateCallId`.
- **R-I3** `ops` unsigned-tx is greenfield per VM (not "fill nonce/gas and sign-as-is" on an existing path — the path doesn't exist). Scope it as new work in the gated plan.

---

## 5a · Dashboard / frontend (greenfield multi-network lift — was under-specified)

Verified: `market-dashboard/components/wallet-provider.tsx` is hard-wired Solana (`SolanaWalletProvider`, `clusterApiUrl`, `WalletAdapterNetwork.Devnet`, Phantom/Solflare, `@solana/wallet-adapter-react-ui`). `app/ops/page.tsx` is a literal `TODO` stub (`<div>Ops</div>`). The per-VM ops-signing path does not exist. This is **new work, not a refactor**:

- **Dual wallet stack.** Keep Solana wallet-adapter; add an EVM connector (wagmi + viem, e.g. RainbowKit) behind a `WalletProvider` that switches on the selected network's `vm`. Not a dropdown — two distinct provider trees + a network-switch UX.
- **Per-VM ops signing.** `ops.service.ts` returns `{ network, vm, unsigned }`; the dashboard signs with the matching wallet — Solana = sign a message/tx via wallet-adapter; EVM = `walletClient.sendTransaction` with adapter-filled nonce/gas. Both paths are unbuilt today.
- **Ops console is greenfield.** `app/ops/page.tsx` is a stub — building the multi-network ops UI is net-new, scoped as its own gated piece, sequenced after the adapter exists.
- **Reads** (stats/endpoints/agents) are already DB-backed via the indexer API → automatically multi-network once the API exposes `?network=`; only the write/sign surfaces need the wallet split.

Effort: comparable to a small feature, not a config change. Flag to the lead as a distinct workstream with its own milestone.

## 6 · Shared data contracts

- **`SettlementEvent`** (§2.2) — exactly one additive field `+network` (string, optional→required over one release). `premiumLamports`/`refundLamports` stay (decimal strings); `outcome` stays (NOT collapsed to `breach`).
- **Indexer ingest DTO** — `SettlementEventDto`/`WrapCallEventDto` also gain `+network`; `EventsService` writes it through.
- **DB** — `+network` non-null on `Endpoint`, `Call`, `PoolState`, `Settlement`, `SettlementRecipientShare`, `RecipientEarnings`, settler watermark, and the `OperatorAllowlist`/`DemoAllowlist` tables (which also have base58-sized identity columns — widen for 0x, §2.5); idempotency key `(network, callId)` not `signature` (§2.6); additive migration, backfill default `solana-mainnet`.
- **Queue/topic naming** — `pact-settle-<network>` (e.g. `pact-settle-arc-testnet`); one subscription per settler fleet.
- **Metrics** — `settler_signer_gas_baseunits{network,asset}`, `indexer_sync_lag{network}`, `proxy_settlement_published_total{network}`. All network-labelled.

## 7 · Deployment topology (fleet-per-network)

| Unit | Cardinality | Network binding |
|---|---|---|
| `market-proxy` | 1 (edge, multi-network per §3.4-B) | per-request, from matched endpoint |
| `settler` | 1 **per network** | `NETWORK` env, own signer + queue + RPC; pushes `/events` (`+network`) |
| `indexer-config-sync` | 1 **per network** | `NETWORK` env, own RPC; `adapter.readEndpointConfigs()` cron only (no per-call cursor) |
| `indexer-ingest/api/stats` | 1 shared | none (DB only) — push ingest is chain-agnostic |
| Postgres | 1 shared | `network` column |
| queue/topic | 1 **per network** | `pact-settle-<network>` |

Adding a network = +1 settler deployment, +1 indexer-config-sync deployment, +1 queue, +1 registry row, +1 deployment address-book entry. Zero new app code on the shared ingest/API tier.

## 8 · Migration sequencing — aligned to the architecture spec's phases

Single shared phase numbering with the architecture spec (its §12 P0–P5). Off-chain work maps onto P-phases; no separate S-scheme.

| Phase | Off-chain content |
|---|---|
| **P0** | this spec + architecture §0 ratified (incl. the REV1 corrections) |
| **P1** | architecture-side (`ArcConfig`→`ProtocolInvariants` + `chains.json`); **also touches `protocol-evm-v1-client/constants.ts` + the deploy/verify script — not contract logic, but not zero-risk** (preserve the live USDC-decimals deploy guard) |
| **P2** | `chain-adapters` package; `ChainAdapter` (submit + `readEndpointConfigs` + `buildUnsignedOps`); Solana + EVM impls; parity-tested |
| **P3** | `SettlementEvent`/ingest-DTO `+network`; DB `network` migration (additive, default `solana-mainnet`, dual-read); refactor `submitter` + `on-chain-sync`(config) + proxy `balance` to the **Solana** adapter — byte-identical, regression-gated against current Solana e2e (**riskiest step**, touches live settlement; Gate B = a named Solana e2e fixture set + "zero behavior delta", and a **documented rollback**: revert order = adapter→DTO→DB column, dual-read keeps old path live throughout) |
| **P4** | wire the EVM adapter; stand up the first non-Solana fleet (Arc) end-to-end on testnet; build the per-VM `ops` + dashboard EVM wallet stack (§5a — greenfield, own milestone) |
| **P5** | 0G reconciliation onto the unified stack (architecture spec §7, full package set) |

Each phase captain-gated (Gate A plan-review + Gate B), file-based in `.planning/phases/`. Backfill/webhook (§5.2) are pre-existing stubs — explicitly **out of these phases** unless the lead prioritizes EVM reconciliation.

## 9 · Risks (cross-service)

- **R1** S3 regresses live Solana settlement → mitigate: Solana adapter is a pure wrapper; Gate B requires byte-identical e2e vs current.
- **R2** `SettlementEvent` `+network` consumed by an old settler/indexer mid-rollout → mitigate: `network` optional in P3, defaulted to `solana-mainnet` by consumers, required only after all consumers read it. No field renamed (the earlier `premium*` alias plan was wrong — see §2.2).
- **R3** per-network signer-balance thresholds mis-set on a new chain → mitigate: registry requires `signerWarn`/`signerCrit` per network; deploy guard fails if absent.
- **R4** proxy multi-network edge (§3.4-B) leaks one network's USDC mint into another's balance check → mitigate: `BalanceCheck` is constructed per matched endpoint from `descriptor`, never global.

## 10 · Decisions — LOCKED (mirrors architecture spec §11)

1. **§3.4 proxy mode:** **DECIDED — option B (multi-network at the edge) for the proxy only**; settler + indexer-config-sync stay single-network per fleet (§2.4).
2. **D1–D6 (inherited from architecture §11):** all locked 2026-05-20 + **Rick green-lit 2026-05-20**. D3 updated by Rick: **0G deferred entirely** — PR #206 stays open as a hackathon artifact but is not merged/integrated; no near-term reconciliation work (architecture §7 is the future plan-of-record).
3. **§5a dashboard EVM wallet stack + per-VM `ops` signing:** confirmed **greenfield, distinct milestone**, not folded into the adapter refactor; sequenced under P4 with its own Gate A.
4. **§2.6 per-VM finality / reorg-rollback policy:** confirmed **hard gate before any EVM fleet goes live (P4 entry criterion)** — must be authored before P4 Gate A.
5. **Fleet-per-network runtime (§2.4):** confirmed acceptable; N settler + N indexer-config-sync deployments, shared push-ingest/API/DB tier.

(See architecture spec §11 for the canonical decision text and §12 for the captain-gated phase plan.)

## 11 · Out of scope

The Agent SDK's own chain interaction (Ken's draft) — covered by architecture spec §8/§9 (the SDK's `@pact-network/core` must seat the same `ChainAdapter`). Parametric-model services (`backend`/scorecard) — separate product track, not on this settlement path.
