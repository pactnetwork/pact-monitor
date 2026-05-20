# Pact Multi-Network Architecture — Detailed Spec Design

- **Date:** 2026-05-19
- **Status:** DRAFT — REV1 hardened; **all six decisions in §11 LOCKED 2026-05-20** (captain) + **Rick green-lit 2026-05-20** ("looks good… lets ship this fast"; 0G deferred — PR #206 stays open as hackathon artifact, no integration); pending captain Gate A on P1
- **Author:** Captain (pact-network), from the 2026-05-19 design session
- **Extends:** `docs/evm/2026-05-15-evm-expansion-design.md` — exists on branch `origin/feat/evm-expansion-design` (PR #201), **NOT on this branch**; feeds the cli-netswitch A2/A8 decisions
- **Evidence base (in-repo, verified):** `protocol-v1-client`, `protocol-evm-v1` (Arc, PR #204), `origin/feat/pact-0g` (PR #206)
- **External / unverifiable in-repo:** Ken's Agent SDK draft = `~/Downloads/SDK Design - Pact Network/Pact Agent SDK — Design Draft.html` (external artifact, never committed; **there is no `docs/SDK-DESIGN.md`**). All §8/§11.5 claims about SDK task "A1" are **assumptions pending that external draft**, not verified facts.

> **REV1 (2026-05-19, post independent review):** corrected — header provenance fixed (no fabricated `docs/SDK-DESIGN.md`); §3 L2 `ChainAdapter` corrected (the indexer per-call path is PUSH, not a symmetric `watch()` — there is no Solana event-sync to wrap); §7 0G package set completed (`settler-evm`/`protocol-zerog-client`/`pact-zerog-dashboard` were missing); §8/§11.5 downgraded to assumptions; dashboard lift cross-referenced (off-chain spec §5a). See the off-chain companion's REV1 note and the review coverage matrix.

---

## 0 · Decision lock

> **LOCKED (2026-05-19):** The Arc 3-contract set — `PactRegistry` + `PactPool` + `PactSettler` (+ `PactEvents`, interfaces, errors) — is the **canonical EVM contract codebase**. 0G's single `PactCore.sol` is retired. One EVM contract package deploys to every EVM chain; per-chain difference is configuration data, never code.

Rationale (evidence, not preference):

| | 0G `PactCore` (1 contract) | Arc (3 contracts) |
|---|---|---|
| Access control | raw single-address `admin` / `settlementAuthority` checks | OZ `AccessControl`, `SETTLER_ROLE`, two-layer grant — rotatable, multi-signer |
| Custody isolation | pool balances co-mingled in one 321-SLOC contract/storage | money isolated in `PactPool` (88 SLOC); audit/upgrade blast radius minimized (PR #201 §3.3) |
| On-chain proof | unit-tested only; **never deployed** | full economic e2e with real USDC on live Arc Testnet, captain-gated, parity matrix |
| Parity fidelity | ≥2 unverified divergences from locked Solana seams (dedup-SET ordering; status enum +1 shift) | seams source-verified vs `settle_batch.rs` |

0G loses **nothing functional** by converging — its real 0G value-add (ERC-7857 INFT, 0G Storage, 0G Compute) lives in separate packages, not the settlement contract. The only core-level 0G feature is `agentTokenId` (one optional struct field, portable to the Arc Registry).

The remaining decisions (NOT locked here — they need Rick, §11): A2/A8 scope, parametric-vs-rails on EVM, and **who owns the 0G reconciliation and whether it lands before or after PR #206 merges**.

---

## 1 · Problem

Pact is on three networks via three different approaches:

| Network | VM | Approach | State |
|---|---|---|---|
| Solana | Solana / Pinocchio | original; `protocol-v1-client`, settler/indexer/db/proxy Solana-coupled | live |
| Arc | EVM | PR #204; `protocol-evm-v1` + `protocol-evm-v1-client`, parity port | done, not wired into off-chain stack |
| 0G | EVM | PR #206; **standalone full fork** — 9 new packages (`protocol-zerog-*`, `indexer-evm`, `db-zerog`, …), +22.8k LOC | hackathon branch |

The fork-per-chain anti-pattern is **already in production**. Arc and 0G are both EVM/rails yet are two divergent contract trees, and 0G forked the off-chain stack too. At N networks this is N codebases. The protocol's behavioral contract (premium-in, floor-div fee split, pool-as-residual, SLA refund, dedup, exposure cap) is **identical on every chain** — that invariance is what makes a single abstraction possible.

## 2 · Goals / non-goals

**Goals**

- **Functional parity (acceptance criterion, Rick 2026-05-20):** every supported network reaches functional parity with the current Solana off-chain stack — proxy / settler / indexer / read API / dashboard / ops — **EXCEPT pay.sh** (x402 facilitator, Solana-only for v1; not yet ported elsewhere). What Pact does today on Solana, it does on Arc / future EVM chains, via the same backend endpoints routed by the new `+network` field.
- One EVM contract codebase; adding an EVM chain = config + deploy, zero new Solidity.
- A single chain-abstraction interface every off-chain consumer depends on; no `@solana/*` or `viem` leakage past the adapter boundary.
- One DB schema, one network registry — the single place a network is added.
- Absorb the Arc port, the 0G fork, and Ken's SDK merge into one coherent model.

**Non-goals**

- Cross-VM contract unification (Solana Rust vs EVM Solidity is irreducibly per-VM — that is accepted, not solved).
- Re-porting or re-deploying the Arc contracts (LOCKED, proven; §0).
- New on-chain instructions/behavior. This spec is structure + seams only.
- Solving the parametric-vs-rails product split (scoped in §10, decision deferred to Rick).

## 3 · Architecture — three layers

### Layer 1 — Contracts: per-VM, not per-chain

- `program/programs-pinocchio/pact-network-v1-pinocchio` — Solana VM, per-cluster config only.
- `program-evm/protocol-evm-v1` — **the one EVM codebase** (Arc 3-contract set). Deploys unchanged to Arc / 0G / Base / Arbitrum / future EVM. Contracts already take USDC + config as constructor args; nothing chain-specific belongs in `src/*.sol`.
- A genuinely new VM (Move/Sui, etc.) = one new contract package — per-VM, never per-chain.

**Invariant (the rule that prevents re-forking):** no chain name and no per-chain value ever appears in `src/*.sol`. Contracts are pure protocol logic. USDC address, chain id, RPC, explorer, verifier backend, gas-token quirks are *data*, supplied at deploy time and recorded in the address book. Proof it works: Arc's USDC-is-native-gas-token quirk was handled by a runtime `decimals()==6` guard + constructor param, not a fork.

### Layer 2 — ChainAdapter: the load-bearing seam

A single TypeScript interface that **is the parity matrix expressed as code**. Every off-chain consumer (settler, indexer, market-proxy, dashboard, Agent SDK) depends on this, never on a chain client directly.

```ts
// @pact-network/shared (or @pact-network/core when Ken extracts it — see §9)

export type Vm = "solana" | "evm";

export interface NetworkDescriptor {
  network: string;          // registry key, e.g. "solana-mainnet" | "arc-testnet" | "0g-galileo"
  vm: Vm;
  chainId?: number;         // EVM
  cluster?: string;         // Solana
  usdc: string;             // mint (Solana) | ERC-20 address (EVM)
  usdcDecimals: 6;          // protocol invariant; deploy guard enforces
  rpcUrl: string;
  explorerUrl: string;
  verifier?: "blockscout" | "etherscan" | "sourcify"; // EVM contract verification backend
}

export interface ChainAdapter {
  descriptor(): NetworkDescriptor;

  // admin / authority
  registerEndpoint(args: RegisterEndpointArgs): Promise<TxRef>;
  updateEndpointConfig(args: UpdateEndpointConfigArgs): Promise<TxRef>;
  updateFeeRecipients(args: UpdateFeeRecipientsArgs): Promise<TxRef>;
  pauseEndpoint(slug: Slug, paused: boolean): Promise<TxRef>;
  pauseProtocol(paused: boolean): Promise<TxRef>;
  topUpPool(slug: Slug, amount: bigint): Promise<TxRef>;

  // settlement (settler) — consumes the WIRE SettlementEvent[] (wrap/src/types.ts, +network);
  // the adapter owns the wire->on-chain projection currently in SubmitterService.submit()
  settleBatch(events: WireSettlementEvent[]): Promise<TxRef>;

  // reads
  getEndpoint(slug: Slug): Promise<EndpointConfig | null>;
  getPool(slug: Slug): Promise<PoolState | null>;
  getRecipientEarnings(slug: Slug, recipient: string): Promise<bigint>;

  // indexer config refresh (NOT a per-call cursor — see correction below)
  readEndpointConfigs(): Promise<EndpointConfig[]>;

  // ops (greenfield per VM — unbuilt even on Solana today)
  buildUnsignedOps(op: OpsAction): Promise<{ vm: Vm; unsigned: unknown }>;

  // EVM-only, POST-v1 reconciliation/backfill (Solana has no equivalent; not on the
  // multi-network critical path): tail finalized CallSettled logs to repair a missed push
  tailSettlementEvents?(fromFinalizedBlock: bigint): AsyncIterable<SettlementEventDecoded>;
}
```

> **CORRECTION (REV1):** the earlier draft had a symmetric `watch(fromBlockOrSlot)` + `decodeEvents` "for the indexer". That was wrong. **The per-call settlement data path is PUSH** — the `settler` pushes settled batches to `indexer POST /events`; `indexer/sync/on-chain-sync.service.ts` is *only* a 5-min `EndpointConfig` refresh, with no slot cursor and no per-call event sync. So: there is no Solana per-call `watch` to wrap; `readEndpointConfigs()` replaces the symmetric `watch`; EVM reuses the same PUSH model (a `settler` fleet for the EVM network pushes the same `/events` contract, network-tagged). `tailSettlementEvents` is optional, EVM-only, post-v1 reconciliation — not the primary indexing path. Detail in the off-chain companion spec §5 (REV1).

Implementations:

- `SolanaAdapter` — wraps `@pact-network/protocol-v1-client` (`register_endpoint`, `settle_batch`, PDA decoders).
- `EvmAdapter` — wraps `@pact-network/protocol-evm-v1-client`, **parameterized by `chainId`**. One implementation covers Arc + 0G + every future EVM chain.

The verb set is the *intersection* both the rails model and the parametric model can satisfy at the right level (provision / record-and-settle / read / refund-status). Where the two product models diverge (§10) the interface stays at the rails level for v1; parametric extensions are an additive sub-interface, not a fork.

### Layer 3 — Chain-agnostic services + network registry + one DB

- `settler`, `indexer`, `market-proxy`, `market-dashboard` consume a `ChainAdapter` resolved from the registry by `network` key. No chain client imported directly. `indexer-evm` / `db-zerog` forks are deleted.
- **One network registry** (config-driven, single source of truth):

```ts
export const NETWORKS: Record<string, NetworkDescriptor> = {
  "solana-mainnet": { network:"solana-mainnet", vm:"solana", cluster:"mainnet-beta",
                      usdc:"EPjF…Dt1v", usdcDecimals:6, rpcUrl:"…", explorerUrl:"…" },
  "solana-devnet":  { /* … 5jBQb7… cluster devnet … */ },
  "arc-testnet":    { network:"arc-testnet", vm:"evm", chainId:5042002,
                      usdc:"0x3600…0000", usdcDecimals:6, rpcUrl:"…",
                      explorerUrl:"https://testnet.arcscan.app", verifier:"blockscout" },
  "0g-galileo":     { network:"0g-galileo", vm:"evm", chainId:16602,
                      usdc:"<0g-usdc>", usdcDecimals:6, rpcUrl:"…", explorerUrl:"…" },
  // add a chain = add a row here. Nothing else.
};
```

- **One DB schema.** Every per-endpoint table (`PoolState`, `Settlement`, `SettlementRecipientShare`, `RecipientEarnings`) gains a non-null `network` column; primary/unique keys become composite `(network, …)`. No per-chain DB package.

## 4 · Package layout (concrete, what moves)

```
packages/
  shared/                      # hosts ChainAdapter + NetworkDescriptor + NETWORKS registry (until §9 moves it to core)
  protocol-v1-client/          # Solana client (unchanged) — wrapped by SolanaAdapter
  protocol-evm-v1-client/      # EVM client (unchanged) — wrapped by EvmAdapter, chainId-parameterized
  chain-adapters/              # NEW: SolanaAdapter, EvmAdapter, resolveAdapter(network)
  program/programs-pinocchio/pact-network-v1-pinocchio/   # Solana contracts (unchanged)
  program-evm/protocol-evm-v1/                            # THE one EVM codebase
    src/  PactRegistry.sol PactPool.sol PactSettler.sol PactEvents.sol
          ProtocolInvariants.sol   # was ArcConfig.sol — keep ONLY invariants (EXPECTED_USDC_DECIMALS=6, MAX_BATCH_SIZE, MAX_TOTAL_FEE_BPS …)
    config/chains.json           # per-chain deploy params: { "5042002":{usdc,name,verifier}, "16602":{…}, … }
    script/Deploy.s.sol          # chain-agnostic: reads chainId + chains.json, NOT a chain-named lib
    foundry.toml                 # [rpc_endpoints] + [etherscan]/verifier — one alias per chain
    broadcast/Deploy.s.sol/<chainId>/   # Foundry auto-namespaces per chain
    deployments/<chainId>.json          # canonical deployed-address book (generated)
  settler/ indexer/ market-proxy/ market-dashboard/   # consume chain-adapters; no chain client import
  db/                          # ONE schema; +network discriminator

FULL 0G fork set (verified, origin/feat/pact-0g) — every package classified in §7:
  DELETE/FOLD: protocol-zerog-contracts, protocol-zerog-client, indexer-evm,
               db-zerog, settler-evm, pact-zerog-dashboard, market-proxy-zerog
  KEEP (0G add-ons): zerog-storage-client, zerog-compute-client
RENAMED: protocol-evm-v1/src/ArcConfig.sol -> ProtocolInvariants.sol
         (chain values -> chains.json; ALSO touches protocol-evm-v1-client/constants.ts
          + Deploy.s.sol; preserve the live USDC-decimals deploy guard — not zero-risk)
```

Package name stays `protocol-evm-v1` — `v1` is the *protocol version* (parallels Solana `protocol-v1-client`), not a chain. The chain never appears in a package name or in `src/`.

## 5 · Deploy & address-book model

1. Add the chain to `config/chains.json` (usdc, name, verifier) + a `[rpc_endpoints]`/`[etherscan]` alias in `foundry.toml`.
2. `forge script Deploy.s.sol --rpc-url <alias> --broadcast --verify` — same contracts, USDC-decimals guard runs first (loud fail on mismatch, zero on-chain action).
3. Foundry writes `broadcast/Deploy.s.sol/<chainId>/`; a post-step extracts the canonical address book to `deployments/<chainId>.json` and the TS client `DEPLOYMENTS[chainId]` map (which already exists and is already designed for this — comment: "Add new chains here as the protocol expands").
4. The network registry (`NETWORKS`) row references those addresses; settler/indexer resolve by `network`.

## 6 · DB multi-network change

Prisma: add `network String` to `Endpoint`, `Call`, `PoolState`, `Settlement`, `SettlementRecipientShare`, `RecipientEarnings`, the settler watermark, and `OperatorAllowlist`/`DemoAllowlist` (whose identity columns are base58-sized — widen for 0x, off-chain spec §2.5). Composite keys `(network, …)`. **Idempotency key for ingest = `(network, callId)`, NOT `signature`** (an EVM reorg replays a tx under a new hash — off-chain §2.6). Migration is additive (new column, backfill default `solana-mainnet`, dual-read during cutover; rollback = drop column after reverting consumers — off-chain §8 P3).

## 6a · Off-chain services (proxy / settler / indexer)

Detailed per-service design — chain-coupled seams per file, the `SettlementEvent` `+network` change, per-VM auth/secrets, reorg/finality, the **dashboard greenfield wallet lift (§5a)**, and the P-phase mapping — is in the companion: **`docs/evm/2026-05-19-multi-network-offchain-services-spec.md`** (read its REV1 note). Corrected summary: the per-call path is **PUSH** (proxy→queue→settler→`/events`→indexer DB), not chain-sync; the only indexer chain read is a config refresh (`adapter.readEndpointConfigs()`); the interface precedent already exists twice (`wrap.BalanceCheck`/`EventSink`, `settler.QueueConsumer`); services resolve `NETWORK`→registry→`ChainAdapter`; settler + indexer-config-sync run one fleet per network; the DB + push-ingest + read API are a single shared multi-network tier.

## 7 · 0G reconciliation (concrete delta — FULL fork set, verified `origin/feat/pact-0g`)

Every forked 0G package classified (the earlier draft listed only 3 — undercount; this is the complete set):

| 0G package | Disposition | Why |
|---|---|---|
| `protocol-zerog-contracts` (`PactCore.sol`) | **DELETE** | retired (§0); Arc 3-contract set canonical |
| `protocol-zerog-client` | **DELETE** | replaced by `protocol-evm-v1-client` via `EvmAdapter` |
| `settler-evm` | **DELETE / FOLD** | this is exactly the per-chain settler fork the spec exists to prevent → fold into unified `settler` + `EvmAdapter` |
| `indexer-evm` | **DELETE / FOLD** | unified `indexer` push-ingest is chain-agnostic; EVM uses the same `/events` contract |
| `db-zerog` | **DELETE** | one `db` + `network` column |
| `pact-zerog-dashboard` | **DELETE / FOLD** | folds into `market-dashboard` once the EVM wallet stack exists (off-chain §5a — greenfield) |
| `market-proxy-zerog` | **FOLD** | into `market-proxy` behind a network/mode profile |
| `zerog-storage-client` | **KEEP** | genuine 0G add-on (0G Storage evidence blobs) — not on the core path |
| `zerog-compute-client` | **KEEP** | genuine 0G add-on (0G Compute) — not on the core path |

| Action | Detail |
|---|---|
| Port one field | optional `agentTokenId` (ERC-7857 INFT) into Arc `PactRegistry` `EndpointConfig` — additive; **still a contract change = its own captain-gated cycle** (§13 R5), not folded into P1 |
| Redeploy | Arc 3-contract set on 0G Galileo (chain 16602) via `chains.json` + `Deploy.s.sol` |
| Re-point | 0G traffic onto unified `settler`/`indexer`/`market-proxy`/`market-dashboard` + `chain-adapters` (EvmAdapter @ 16602) + unified `db` |

**Status (Rick, 2026-05-20):** 0G reconciliation is **deferred indefinitely** — the network is still too new to invest in. PR #206 stays open as a hackathon artifact but is **not merged or integrated**; this full fork-set classification is retained as the future plan-of-record. When 0G matures and there is real product demand, this table is the migration checklist.

When it eventually happens, this is a redeploy + retarget, **not a rewrite** — but per D3 (above), it is deferred until 0G is mature.

## 8 · Interaction with Ken's Agent SDK (ASSUMPTION — external artifact, not in-repo)

> The Agent SDK draft is an **external file** (`~/Downloads/SDK Design - Pact Network/…html`), not in the repo. The following is an **assumption to confirm with Ken/Rick**, not a verified in-repo fact, and the §11.5 item is gated on producing/locating that draft.

Per the external draft, the SDK merges `pact-monitor` + `pact-insurance` into one `@pact-network/sdk` over a shared `@pact-network/core`. **Constraint this spec proposes:** the `core` extraction task (the draft calls it "A1") should seat the `ChainAdapter` interface at the core coverage-client seam — `core` depends on the interface, not on `@solana/kit` directly. If it hardwires Solana, the flagship SDK is Solana-only and the multi-network problem recurses; retrofitting post-mainnet is a breaking change. This is the assumed time-critical coupling against the draft's "M0" sign-off — **verify against the actual draft before treating as blocking.**

## 9 · Where the interface lives

Initially `@pact-network/shared` (zero-dep leaf, already a clean seam). When Ken extracts `@pact-network/core` (SDK task A1 / M7), the `ChainAdapter` + `NetworkDescriptor` + `NETWORKS` registry move there so the Agent SDK, merchant SDK, market-proxy, settler, and indexer all import the one definition. `chain-adapters` (the implementations) stay a separate package depending on `core` + the two clients (avoids `core` pulling `@solana/web3.js` + `viem` into every consumer; matches Ken's §13 OPEN browser-bundle concern).

## 10 · The parametric-vs-rails scoping note

Two on-chain product models exist: **rails** (`register_endpoint`/`settle_batch`; Solana v1, Arc, 0G) and **parametric** (`enable_insurance`/`submit_claim`; the separately-published `@q3labs/pact-insurance@0.2.0` lineage — verified a distinct scope, per the NPM-scope policy). This spec defines `ChainAdapter` at the **rails** level for v1, because all three live deployments are rails. Parametric is an additive sub-interface later, not a fork. Whether EVM chains ever carry the parametric model is the Rick/A2 question (§11) and is out of scope here. (An earlier draft cited a "contradiction in Ken's SDK draft" re: program ids — that is unverifiable in-repo since the draft is external; dropped as evidence.)

## 11 · Decisions — LOCKED 2026-05-20

1. **D1 (A2):** **adopt one chain abstraction org-wide** (this spec). No new per-chain forks.
2. **D2 (A8):** **`@pact-network/shared`/`core` owns the network registry; the SDK consumes it.**
3. **D3 (0G timing):** **defer 0G entirely** (Rick, 2026-05-20: "for 0G we won't be moving ahead for a bit, network is still so new"). The 0G `PactCore` design is retired (§0); PR #206 **stays open** as a hackathon artifact but is **not merged or integrated**; the full 9-package fork-set reconciliation (§7) is **deferred indefinitely** — no near-term ticket needed. When 0G matures, it slots in via `chains.json` as just another EVM chain ("0G is EVM, in theory it should be portable" — Rick).
4. **D4 (parametric on EVM):** **rails-only on EVM for v1.** Parametric stays Solana-only; an additive sub-interface lands only if real demand surfaces. Verified: Pinocchio v1 + Arc + 0G all expose the same rails verbs; parametric instructions live only in the frozen Anchor `pact-insurance` crate + unshipped `pact-network-v2-pinocchio` (see §10).
5. **D5 (SDK coupling):** **chain adapter at the `core` seam is a precondition of Ken's SDK M0.** Ken must confirm/correct §8 against the actual (external) SDK draft.
6. **D6 (reorg policy):** **per-VM finality + reorg-rollback policy is a hard gate before any EVM fleet goes live** (P4 entry criterion). Detail off-chain §2.6.

Plus the standing rule re-confirmed: **the legacy Anchor `pact-insurance` crate (`2Go74e…`) is FROZEN** — no edits, no builds, no tests, no IDL work, do not propose it as the target of any new design. Pinocchio (Solana) and the Arc 3-contract Solidity set (EVM) are the canonical surfaces.

## 12 · Sequencing

Shared P-numbering with the off-chain companion (its §8 maps onto these — single scheme, no separate S-plan):

- **P0** — this spec + decision lock (§0) ratified incl. REV1 corrections (captain Gate A + Rick on §11). *(current)*
- **P1** — generalize the EVM package: `ArcConfig.sol` → `ProtocolInvariants.sol` + `chains.json` + chain-agnostic `Deploy.s.sol`. **Not contract logic, but NOT zero-risk**: also touches `protocol-evm-v1-client/constants.ts` + the deploy/verify script; the live USDC-decimals deploy guard must be preserved through the move (I6).
- **P2** — `chain-adapters` package: `ChainAdapter` (submit + `readEndpointConfigs` + `buildUnsignedOps`) in `shared`, `SolanaAdapter` + `EvmAdapter`, parity-tested.
- **P3** — `SettlementEvent`/ingest-DTO `+network`; DB `network` migration (additive, dual-read); refactor `submitter` + `on-chain-sync`(config) + proxy `balance` to the **Solana** adapter. **Riskiest — touches live Solana settlement**; Gate B = named Solana e2e fixtures + zero behavior delta + a documented rollback (revert adapter→DTO→column; dual-read keeps the old path live throughout).
- **P4** — wire `EvmAdapter`; first non-Solana fleet (Arc) e2e on testnet; the per-VM `ops` + dashboard EVM wallet stack (off-chain §5a — **greenfield, its own milestone**).
- **P5** — Ken SDK `core` hosts the chain-adapter seam (D5, coordinated with the external SDK milestones). **0G reconciliation (§7 full set) is deferred per D3** — no near-term work; the §7 table is the future plan-of-record when 0G matures.

Each phase captain-gated (Gate A + Gate B), file-based in `.planning/phases/`, contracts LOCKED (any contract change incl. `agentTokenId` = a new captain-gated cycle).

## 13 · Risks

- **R1** — Adapter interface defined too narrowly for the parametric model later → mitigate: rails-level v1 verbs are a strict subset; parametric is additive (§10).
- **R2** — 0G reconciliation slips and #206 merges unscoped → mitigate: gate the merge on a reconciliation ticket (§11.3).
- **R3** — external SDK draft signs off with Solana-hardwired `core` → mitigate: §8 is an assumption; locate the draft and escalate to Rick before its M0.
- **R4** — DB `network` migration on a live indexer (push-fed, no chain backfill exists) → mitigate: additive column, default `solana-mainnet`, dual-read; P3 rollback documented. Note: a lost settler push has no recovery path on Solana today (pre-existing gap, off-chain §5.4 R-I1) — multi-network neither fixes nor worsens it.
- **R5** — `agentTokenId` port to Arc Registry touches a LOCKED contract → additive but still a contract change: a new captain-gated cycle, not folded into P1.
- **R6** — EVM reorg replays a tx under a new hash, breaking `signature`-keyed ingest idempotency → mitigate: idempotency key is `(network, callId)`, finalized-commitment only, on-chain `DuplicateCallId` backstop (off-chain §2.6).

## 14 · Out of scope / future

New VM (Move/Sui/…): one new contract package + one new `ChainAdapter` impl + registry rows. The off-chain stack and DB do not change — that is the entire point of Layer 2/3. Ethereum L1 mainnet remains v2-at-scale (gas economics, per PR #201 audit trail).
