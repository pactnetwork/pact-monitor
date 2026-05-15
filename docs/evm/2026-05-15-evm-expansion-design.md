# Pact Network — EVM Expansion Design

**Status:** DRAFT — design proposal, not yet implemented.
**Author:** Pact Network engineering
**Date:** 2026-05-15
**Branch:** `feat/evm-expansion-design`
**Scope:** Research + design only. No Solidity. No new packages. No source changes.

---

## 1. Goal

Pact Network v1 ships on Solana (Pinocchio program at
`5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` mainnet,
`5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` devnet). Rick wants to port the
protocol to one or more EVM chains so agents that pay with ERC-20 USDC can also
get insured calls.

This doc maps the Solana primitives we already use onto EVM equivalents, sketches
the Solidity contract shape, picks a target chain, and lays out the work needed
without prescribing implementation details that should be decided at WP time.

---

## 2. Solana → EVM primitive mapping

The Solana side of v1 leans on six on-chain primitives. Each has a clean EVM
analogue; the table below is the canonical translation we'll reference throughout.

| # | Solana primitive (v1) | EVM equivalent | Notes / friction |
|---|---|---|---|
| 1 | **SPL Token approve / delegate** — agent calls `Approve(SettlementAuthority PDA, N)` once; program signs transfers as the PDA via `invoke_signed`. Pre-flight delegate check at `settle_batch.rs:295-314`. | **ERC-20 `approve(PactSettler, N)`** — agent approves the `PactSettler` contract for `N` USDC; settler calls `transferFrom(agent, pool, premium)` during batch settlement. | One-to-one map. ERC-20 allowance is a `mapping(address => mapping(address => uint256))` lookup. The "delegate pre-flight" we do in `settle_batch` to mark `DelegateFailed` becomes a try/catch around `transferFrom` (or a pre-`allowance()` read) — EVM lets us catch the revert cleanly with `try ... catch`, which is actually nicer than what we have on Solana. |
| 2 | **PDAs** — `find_program_address([b"coverage_pool", slug])`, `[b"endpoint", slug]`, `[b"call", call_id]`, `[b"settlement_authority"]`, `[b"treasury"]`, `[b"protocol_config"]`. See `pda.rs:6-37`. | **CREATE2 deterministic deployment** for per-endpoint contracts, or a **single contract with `mapping(bytes16 => Pool)`** keyed on the slug. CallRecord-style dedup becomes `mapping(bytes16 => bool) settled` or `mapping(bytes16 => CallRecord)`. | Strong recommendation: skip CREATE2-per-endpoint and use a single `PactPool` contract with internal storage keyed on `bytes16 slug` (matches Solana's 16-byte slug). CREATE2 only buys us "addressable like a Solana PDA"; it costs an extra deploy per endpoint (~$5-50 of gas on L2s) and complicates the indexer. See §4. |
| 3 | **Program state accounts** — `CoveragePool` (160B), `EndpointConfig` (544B), `CallRecord` (112B), `ProtocolConfig` (464B), `Treasury` (80B), `SettlementAuthority` (48B). Plain-old-bytemuck structs in `state.rs`. | **Contract storage slots** — Solidity structs in mappings. | EVM doesn't have rent. We do pay one-time storage gas (~20k gas per `SSTORE` from zero); after that, reads are free off-chain via `eth_call`. The 544-byte `EndpointConfig` becomes a struct with `FeeRecipient[8]` packed into one mapping value; we can drop most of the explicit padding because Solidity handles slot packing for us. |
| 4 | **Instruction discriminators + raw byte parsing** — single `process_instruction` with a leading byte switch (`lib.rs:38-71`, `discriminator.rs`). Wire format is hand-rolled little-endian (`settle_batch.rs:34-47`). | **Solidity function selectors (4-byte hash)** + ABI-encoded calldata. The contract has one external function per discriminator (`registerEndpoint`, `settleBatch`, etc.); the EVM dispatches on `msg.sig`. | Free win. We get type-safe calldata, free ABI for clients, free events for indexers. The 104-byte hand-rolled per-event struct in `settle_batch` becomes a Solidity struct array argument. |
| 5 | **Event emission** — currently **none** on-chain. The Solana program emits no `msg!` / `sol_log` events; off-chain indexing requires the settler to publish events into Pub/Sub via the wrap library, and the indexer trusts that channel rather than the chain. (See memory observation `6131`.) | **Solidity `event` + `emit`** — first-class Ethereum log primitive. Indexed args become topics (cheap filter for The Graph / custom indexers). | Big upgrade. EVM `event`s let the indexer source-of-truth from the chain itself (via `eth_getLogs` or a subgraph) instead of trusting the settler's Pub/Sub publish. We should emit on every state transition: `EndpointRegistered`, `BatchSettled` (one event per call inside the batch, indexed by `callId`), `PoolToppedUp`, `FeeRecipientsUpdated`, `EndpointPaused`, `ProtocolPaused`. The Solana side will eventually want this too (logs via `sol_log_data`) but that's out of scope for this doc. |
| 6 | **Settle authority signer** — settler EOA listed in `SettlementAuthority.signer`; PDA is the SPL Token delegate; settler must sign + program signs as PDA via `invoke_signed`. | **`onlyRole(SETTLER_ROLE)`** modifier (OpenZeppelin AccessControl) on `settleBatch`. The settler EOA holds the role; revoking is a single tx. | Simpler than Solana. We don't need a PDA-as-delegate trick: the contract IS the delegate (it's the `spender` in the allowance), and `onlyRole` gates who can call it. Multi-sig the role admin to a Safe before mainnet — same posture as the Squads multisig for Solana upgrade authority. |
| 7 | **Lamport-denominated premiums (USDC)** — Solana stores USDC as 6-decimal "lamports" of mint. All program fields are `u64`. | **ERC-20 `uint256`** — most USDC on EVM is 6-decimal (matches Solana). On Polygon PoS bridged USDC.e was historically 6-decimal too. | Almost free. Rename `premium_lamports` → `premiumAmount` in the Solidity types; storage stays `uint64` for parity (saves a slot if packed with other uint64s). We must confirm 6-decimal on each target chain before launch (Base/Arb/Op canonical USDC = 6, fine; some bridged variants drift). |
| 8 | **Pinocchio 0.10 / cargo build-sbf** | **Solidity 0.8.x + Foundry** (preferred) or Hardhat. | Foundry recommended: native fuzzing, fast tests, `forge script` for deploy, snapshot gas costs. Aligns with the rest of the EVM ecosystem better than Hardhat in 2026. |
| 9 | **Protocol-wide kill switch** — `ProtocolConfig.paused` byte, checked in `settle_batch.rs:99-115` before any per-event work. | **OpenZeppelin `Pausable`** modifier or custom `paused` storage bool. `whenNotPaused` on `settleBatch`. | Direct map. Use OZ Pausable for audit familiarity. |
| 10 | **Per-event status codes** — `SettlementStatus::{Settled, DelegateFailed, PoolDepleted, ExposureCapClamped}` written into the `CallRecord` (state.rs:148-164). | Same enum in Solidity, emitted on the per-call `BatchSettled` event. | Direct map. Existing classifier + indexer code is status-agnostic; it'll see whatever the chain emits. |

### Authority + key rotation note

The Solana side has a "rotate to Squads multisig before mainnet" item on the
launch checklist (`CLAUDE.md` Authority rotation note). On EVM the equivalent
is: deploy with a deployer EOA, then `transferOwnership` (or `grantRole(ADMIN)`
+ `renounceRole`) to a **Safe multisig** before going live. Same posture, same
checklist line. The audit doc at `docs/audits/2026-05-05-mainnet-readiness.md`
flagged this as a mainnet blocker on Solana; we should mirror the same blocker
on the EVM side.

---

## 3. Contract shape

Three logical contracts. We prefer a **single deployment per chain with
internal slug-keyed mappings**, not a factory-per-endpoint. Rationale in §4.

### 3.1 PactRegistry (one contract per chain)

Owns the endpoint registry, fee-recipient policy, protocol config, and the
kill switch. Roughly analogous to `EndpointConfig` + `ProtocolConfig` PDAs
combined.

```solidity
// Sketch — do not implement from this. Final shape decided at WP time.
interface IPactRegistry {
    struct FeeRecipient {
        uint8 kind;        // 0 = Treasury, 1 = AffiliateAta, 2 = AffiliatePda
        address destination;
        uint16 bps;
    }

    struct EndpointConfig {
        bool paused;
        uint64 flatPremium;
        uint16 percentBps;
        uint32 slaLatencyMs;
        uint64 imputedCost;
        uint64 exposureCapPerHour;
        // ...stats fields omitted; mirror state.rs:96-123
        FeeRecipient[8] feeRecipients;
        uint8 feeRecipientCount;
    }

    function registerEndpoint(bytes16 slug, EndpointConfig calldata cfg) external;
    function updateEndpointConfig(bytes16 slug, EndpointConfig calldata cfg) external;
    function pauseEndpoint(bytes16 slug, bool paused) external;
    function pauseProtocol(bool paused) external;
    function updateFeeRecipients(bytes16 slug, FeeRecipient[8] calldata recipients, uint8 count) external;

    event EndpointRegistered(bytes16 indexed slug, address indexed pool);
    event EndpointConfigUpdated(bytes16 indexed slug);
    event EndpointPaused(bytes16 indexed slug, bool paused);
    event ProtocolPaused(bool paused);
    event FeeRecipientsUpdated(bytes16 indexed slug);
}
```

### 3.2 PactPool (one contract per chain, slug-keyed mapping internally)

Holds USDC liquidity. Tracks per-endpoint balance, premiums, refunds. One
contract holds **all** endpoint pools, keyed by `bytes16 slug`. The contract
address IS the receiver for `transferFrom` premium-in and the sender for
fee fan-out + refund.

```solidity
interface IPactPool {
    struct PoolState {
        uint64 currentBalance;
        uint64 totalDeposits;
        uint64 totalPremiums;
        uint64 totalRefunds;
        uint64 createdAt;
    }

    function topUp(bytes16 slug, uint64 amount) external;
    function balanceOf(bytes16 slug) external view returns (PoolState memory);

    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint64 amount);
}
```

### 3.3 PactSettler (one contract per chain — or could be merged into PactPool)

Implements `settleBatch`. Has `SETTLER_ROLE`. Pulls premium from agent
(`transferFrom`), credits pool, fans out fees, pays refund on breach.

```solidity
interface IPactSettler {
    struct SettlementEvent {
        bytes16 callId;
        address agent;
        bytes16 endpointSlug;
        uint64 premium;
        uint64 refund;
        uint32 latencyMs;
        bool breach;
        uint8 feeRecipientCountHint;
        uint64 timestamp;
    }

    enum SettlementStatus { Settled, DelegateFailed, PoolDepleted, ExposureCapClamped }

    function settleBatch(SettlementEvent[] calldata events) external;

    // One event per call inside the batch — indexer reads these directly.
    event CallSettled(
        bytes16 indexed callId,
        bytes16 indexed slug,
        address indexed agent,
        uint64 premium,
        uint64 refund,
        uint64 actualRefund,
        SettlementStatus status,
        bool breach,
        uint32 latencyMs,
        uint64 timestamp
    );
}
```

**Open architectural call:** merge PactSettler into PactPool, or keep separate?
Separate is cleaner (settler holds the role; pool holds the money) but costs an
extra `call` per refund (cross-contract). For an L2 with sub-cent gas this is
fine. **Recommend: separate contracts.**

### 3.4 Recommendation: single contract per role, not per endpoint

The Solana side derives a per-endpoint PDA (`coverage_pool` + slug). The EVM
equivalent **could** be CREATE2-per-endpoint, but we recommend against it:

- Each new endpoint costs a deployment (~$1-$20 on L2s, more elsewhere).
- The indexer must track an unbounded set of pool addresses.
- Audits scale with deployed contract count.
- Single-contract gives O(1) reads via mapping; clients pay one allowance for
  all endpoints (`approve(PactSettler, MAX_UINT)`).

A factory pattern only makes sense if endpoints need contract-level isolation
(e.g., liquidation rights, custom upgrade paths). Pact v1 has none of that —
endpoints are protocol-managed config rows. **Recommend: single PactPool +
single PactSettler + single PactRegistry per chain.**

---

## 4. Chain selection

Hard requirements:

1. Canonical (or Circle-bridged) USDC available with 6 decimals.
2. Per-call gas cost low enough that the premium > gas (premium floor is
   100 lamports = $0.0001 USDC; clearly gas must be sub-cent).
3. EOA-friendly UX so agents don't need to learn a new wallet stack.
4. Mature tooling — Foundry, Etherscan-compatible explorer, public RPC.

Scoring (1 = poor, 5 = excellent):

| Chain | USDC | Gas/call | Ecosystem fit | Audit support | Bridge story | Total |
|---|---|---|---|---|---|---|
| **Base** | 5 (native, Circle) | 5 (~$0.001 typical L2 tx) | 5 (Coinbase-aligned; biggest agent dev community) | 5 (most-audited L2) | 5 (Circle CCTP direct) | **25** |
| **Arbitrum** | 5 (native, Circle) | 5 | 5 (deep DeFi liquidity) | 5 | 5 (CCTP) | **25** |
| **Optimism** | 5 (native, Circle) | 5 | 4 | 5 | 5 (CCTP) | **24** |
| **Polygon PoS** | 3 (USDC.e bridged + native USDC since 2024 — must use native) | 4 | 3 | 4 | 4 | **18** |
| **Polygon zkEVM** | 3 (native USDC limited) | 4 | 2 | 3 | 3 | **15** |
| **Linea** | 3 (Circle USDC live but lower liquidity) | 4 | 2 | 3 | 3 | **15** |
| **BNB Chain** | 4 (BSC-USD ≠ USDC; bridged USDC has lower trust) | 4 | 2 | 3 | 3 | **16** |

**Recommendation: ship Base first, Arbitrum second.**

Rationale:

- **Base** is the highest-leverage launch chain for an AI-agent payment
  product. Coinbase pushes Base hard for agent/AI use cases; Circle USDC is
  native; CDP-issued wallet keys are already EVM-native for many agent
  frameworks (LangChain, Vercel AI SDK demos default to Base).
- **Arbitrum** is the natural follow-up: same UX, larger DeFi treasury pool of
  potential underwriters (when v2 lands), CCTP makes cross-chain USDC
  movement trivial.
- **Skip Polygon and BNB for v1 EVM.** Polygon zkEVM has thin USDC liquidity;
  BNB Chain's USDC is bridged and the chain has a different audit/trust
  posture than the L2 set.

Cross-chain rebalancing of pool USDC (Base ↔ Arbitrum) can use **Circle CCTP**
once both deployments exist — burns on source, mints on dest, no third-party
bridge risk.

---

## 5. Cross-chain shape — multi-chain, not cross-chain

**Strong recommendation: independent deployments per chain, no bridging of
pool liquidity at the protocol level.**

| Option | Description | Verdict |
|---|---|---|
| **A. Multi-chain independent** (recommended) | Each chain has its own `PactRegistry` + `PactPool` + `PactSettler`. Liquidity, endpoints, and call records are chain-local. Treasury and integrators withdraw separately per chain. | Simple, audit-friendly, no bridge attack surface. Each chain failure is contained. |
| **B. Cross-chain pool** | Pool liquidity on chain A backs calls served on chain B. Requires a messaging bridge (CCIP, LayerZero, Wormhole) to relay settlement events and unlock refunds. | Adds a CRITICAL trust assumption (the bridge). 2024-2025 saw multiple eight-figure bridge exploits. Not worth it for v1. |
| **C. Hub-and-spoke (Solana hub)** | Solana stays canonical; EVM is a "spoke" that mirrors Solana state and only emits intent. Settlement still happens on Solana. | Worst of both: agents on EVM pay gas for nothing on-chain, and we still depend on a bridge. |

Multi-chain independent matches the product reality: an agent picks a chain
based on where its wallet + USDC live; the pool that insures the call lives on
the same chain. If the same integrator wants endpoints on Base AND Arbitrum,
they `registerEndpoint` twice — once per chain — and treat them as separate
revenue streams.

Cross-chain consolidation of integrator earnings or treasury rebalancing is an
off-chain ops concern, solved with CCTP transfers, not a protocol primitive.

---

## 6. Off-chain reuse

The off-chain stack is in good shape for a chain split. Here's what survives,
what changes, and where new code is needed.

### 6.1 Survives unchanged

- **`@pact-network/wrap`** — `wrapFetch.ts` is fully chain-agnostic already.
  It calls a `Classifier` (HTTP response → outcome) and an `EventSink`
  (settlement event → wherever). Neither knows or cares about Solana. The
  `BalanceCheck` interface is the only chain-aware seam — see §6.2.
- **`@pact-network/wrap` Classifier** — pure function over `(Response, latencyMs)`.
- **`@pact-network/wrap` EventSink** — interface that publishes a
  `SettlementEvent`; sink implementations (Pub/Sub, Redis Streams, fetch) are
  all chain-agnostic.
- **`@pact-network/market-proxy`** — Hono proxy; consumes `wrap` and writes
  via an `EventSink`. No chain code here.
- **`@pact-network/indexer`** read APIs — `/api/stats`, `/api/endpoints`,
  `/api/agents/:pubkey`. These query Postgres, not the chain.
- **`@pact-network/market-dashboard`** — pure read of indexer APIs.

### 6.2 Needs a chain abstraction

- **`BalanceCheck`** in `wrap`. Today the Solana impl reads SPL Token ATA +
  delegate fields. EVM impl reads ERC-20 `balanceOf(agent)` + `allowance(agent,
  PactSettler)`. Same interface, different backend. Implement
  `BalanceCheck.solana` and `BalanceCheck.evm` and let the proxy pick at
  startup based on endpoint config.
- **`@pact-network/settler`** — currently single-chain. Needs a `ChainAdapter`
  trait with two implementations:
  - `SolanaSettlerAdapter` — current code; builds + signs + sends
    `settle_batch` instruction.
  - `EvmSettlerAdapter` — uses viem or ethers; calls `settleBatch(events)`
    on `PactSettler`. Same input (`SettlementEvent[]`), different submission
    path.
  Batching, idempotency (call_id dedup), retry policy stay shared. The
  submitter is the only file that grows a chain switch.
- **`@pact-network/indexer`** events ingest — currently bearer-gated `/events`
  POST endpoint that trusts the settler. With EVM emitting first-class
  `CallSettled` events, the indexer should grow a **per-chain event indexer**
  that polls `eth_getLogs` (or runs a viem `watchEvent` subscription) and
  writes the same `Call` rows. The existing `/events` POST endpoint stays for
  the Solana path (where there are no on-chain events yet) and as a fallback.

### 6.3 New code

- **`@pact-network/protocol-evm-v1` client** — Solidity ABI bindings, typed
  contract calls (viem), per-chain address registry. Sibling to
  `@pact-network/protocol-v1-client` (the Solana TS client). Same shape: PDA
  helpers → address helpers; instruction builders → typed contract calls;
  account decoders → ABI decoders (free from viem).
- **`@pact-network/protocol-evm-v1` (the Solidity)** — Foundry project. Three
  contracts (Registry, Pool, Settler), tests with fuzzing, deploy scripts.

### 6.4 Component diagram (after the EVM split)

```
                        ┌──────────────────────────────┐
                        │  @pact-network/wrap          │
                        │  (chain-agnostic)            │
                        │  wrapFetch → Classifier      │
                        │            → BalanceCheck    │ ──┐
                        │            → EventSink       │   │
                        └──────────────────────────────┘   │
                                       │                   │ chain-aware
                                       ▼                   │ implementations
                   ┌─────────────────────────────────┐     │
                   │  @pact-network/settler          │     │
                   │  ┌──────────────────────────┐   │     │
                   │  │ ChainAdapter (interface) │   │     │
                   │  └──────────────────────────┘   │     │
                   │       ▲                ▲        │     │
                   │   solana             evm        │     │
                   └─────────────────────────────────┘     │
                       │                  │               │
                       ▼                  ▼               ▼
                ┌─────────────┐    ┌─────────────┐  ┌─────────────┐
                │ Pinocchio   │    │ Solidity    │  │ Solana ATA  │
                │ program     │    │ contracts   │  │ + ERC-20    │
                │ (Solana)    │    │ (Base/Arb)  │  │ balance     │
                └─────────────┘    └─────────────┘  │ readers     │
                                          │         └─────────────┘
                                          ▼
                                   on-chain events
                                          │
                                          ▼
                   ┌─────────────────────────────────┐
                   │  @pact-network/indexer          │
                   │  per-chain event ingest         │
                   │  → Postgres (shared schema)     │
                   └─────────────────────────────────┘
```

---

## 7. Repo layout + naming

### 7.1 Package names

Mirror the existing `protocol-v1-client` (Solana) pattern:

- `@pact-network/protocol-evm-v1` — Solidity contracts + Foundry project +
  generated TS bindings (viem). Replaces the Solana-only role of
  `protocol-v1-client` on the EVM side.
- `@pact-network/protocol-evm-v1-client` — optional pure-TS client wrapper if
  we want to hide viem from consumers. Probably not needed for v1 —
  consumers can `import { abi, addresses } from '@pact-network/protocol-evm-v1'`
  and bring their own viem instance.

### 7.2 Same monorepo or sibling repo?

**Recommend: same monorepo (`pact-network`).**

Pros of in-repo:
- Shared `@pact-network/wrap` consumes both via interface — refactoring the
  interface stays atomic.
- Shared types (`SettlementEvent`, `Outcome`, etc.) live in
  `@pact-network/shared` and both clients use them.
- One CI; one version bump cycle; one mainnet-readiness audit doc.

Cons:
- Solidity tooling (Foundry) in a pnpm monorepo is a slight bolt-on. Turbo
  doesn't natively cache `forge build`; we'd add a custom task. Manageable.
- Rust workspace toolchain and Foundry don't conflict — they sit in different
  subtrees.

The Pinocchio program lives at
`packages/program/programs-pinocchio/pact-network-v1-pinocchio/`. Mirror it:
`packages/program-evm/protocol-evm-v1/` (Foundry project root with `src/`,
`test/`, `script/`).

Off-chain TS bindings: `packages/protocol-evm-v1-client/` sibling to
`packages/protocol-v1-client/`.

### 7.3 Proposed final tree

```
packages/
  protocol-v1-client/                # existing — Solana TS client
  protocol-evm-v1-client/            # NEW — EVM TS client (viem bindings + addresses)
  program/programs-pinocchio/
    pact-network-v1-pinocchio/       # existing — Solana on-chain
  program-evm/
    protocol-evm-v1/                 # NEW — Foundry project (Solidity)
      src/
        PactRegistry.sol
        PactPool.sol
        PactSettler.sol
      test/
      script/
      foundry.toml
  wrap/                              # existing — chain-agnostic
  settler/                           # existing — grows ChainAdapter abstraction
  indexer/                           # existing — grows per-chain event poller
  shared/                            # existing — shared types
```

---

## 8. Effort breakdown (WP / phase list)

Ordered so the **demo path** (Base testnet end-to-end) comes first. Each WP is a
discrete shippable unit. No time estimates per repo convention.

1. **WP-EVM-01 — Solidity scaffold.** Foundry project at
   `packages/program-evm/protocol-evm-v1/`. Empty contract stubs for Registry,
   Pool, Settler. Foundry config, basic CI integration.
2. **WP-EVM-02 — PactRegistry.** Solidity port of `EndpointConfig` +
   `ProtocolConfig` + fee-recipient validation rules from `register_endpoint.rs`,
   `update_endpoint_config.rs`, `update_fee_recipients.rs`,
   `initialize_protocol_config.rs`, `pause_endpoint.rs`, `pause_protocol.rs`.
   Events for every state change.
3. **WP-EVM-03 — PactPool.** Solidity port of `CoveragePool` + `top_up_coverage_pool.rs`.
   Holds USDC; tracks per-slug `PoolState`.
4. **WP-EVM-04 — PactSettler core.** `settleBatch` with premium-in via
   `transferFrom`, fee fan-out, refund on breach. Mirror the per-call
   `SettlementStatus` enum and emit `CallSettled` per event in the batch.
5. **WP-EVM-05 — Settler hardening.** Exposure cap (hourly bucket per
   endpoint), `DelegateFailed` recovery via `try/catch` around `transferFrom`,
   `PoolDepleted` accounting, dedup via `mapping(bytes16 => bool) settled`.
6. **WP-EVM-06 — Foundry test suite.** Mirror the LiteSVM test plan from
   `pact-network-v1-pinocchio/tests/`. Fuzz the bps fan-out and exposure cap.
7. **WP-EVM-07 — Deploy scripts + Base Sepolia deploy.** `forge script`
   targeting Base Sepolia. Operator runbook for `transferOwnership` to a Safe.
8. **WP-EVM-08 — TS client (`protocol-evm-v1-client`).** ABI exports,
   per-chain address registry, viem-based balance + allowance helpers, typed
   `settleBatch` wrapper.
9. **WP-EVM-09 — `wrap` `BalanceCheck.evm` implementation.** Reads
   `balanceOf` + `allowance` via viem. Pass-through into existing `wrapFetch`.
10. **WP-EVM-10 — `settler` `EvmSettlerAdapter`.** Behind a `ChainAdapter`
    interface. Sequential per-chain submission; share batcher + idempotency.
11. **WP-EVM-11 — `indexer` per-chain event poller.** `eth_getLogs` (or viem
    `watchEvent`) for `CallSettled`, `PoolToppedUp`, `EndpointRegistered`.
    Writes to existing Postgres schema with a `chain` column added.
12. **WP-EVM-12 — Postgres schema migration.** Add `chain` enum column to
    `Call`, `Settlement`, `PoolState`, `EndpointConfig`, `RecipientEarnings`.
    Backfill with `'solana'` for existing rows.
13. **WP-EVM-13 — `market-dashboard` chain switcher.** Drop-down in the
    dashboard header; per-chain filter on all stats panels.
14. **WP-EVM-14 — Base Sepolia demo end-to-end.** A real agent calls a real
    insured endpoint on Base Sepolia, premium debited from sepolia-USDC,
    breach triggers refund, dashboard shows the call. **Demo-gate.**
15. **WP-EVM-15 — Audit prep + Safe rotation.** Mainnet readiness audit doc
    for the EVM contracts; same format as
    `docs/audits/2026-05-05-mainnet-readiness.md`. Squads → Safe.
16. **WP-EVM-16 — Third-party audit window.** One firm (Spearbit / Trail of
    Bits / OpenZeppelin). Hold mainnet deploy until written report + fix-PR.
17. **WP-EVM-17 — Base mainnet deploy.**
18. **WP-EVM-18 — Arbitrum mainnet deploy.** Same contract bytecode; new
    addresses; new entry in the address registry.

WP-01..WP-14 is the demo path. WP-15..18 is the production path.

---

## 9. Open questions for Rick

Tight list — each is load-bearing for the WP plan.

- **Chain priority.** Confirm **Base first, Arbitrum second**? Or do you have a
  partnership/customer reason to prioritize Arbitrum, Optimism, or somewhere
  else? (Skip Polygon/BNB unless you push back.)
- **Mainnet vs testnet first.** Demo on **Base Sepolia** end-to-end before
  spending audit budget? (Recommended.) Or push straight to Base mainnet with
  a fresh audit?
- **Gasless / paymaster option.** Do agents on EVM pay their own gas, or do we
  offer a sponsored UX via ERC-4337 paymaster (Pimlico, Biconomy) so the agent
  flow is "USDC in, USDC out, no ETH"? This is the **agent UX call** —
  recommend yes-with-paymaster, but it adds a WP (paymaster integration +
  custody of gas reserves) and a vendor dependency.
- **Pool bridging.** Confirm **independent per-chain pools** (no bridging of
  liquidity)? Or do you want a hub-and-spoke design where Solana stays
  canonical and EVM mirrors? (Strong recommendation: independent.)
- **Audit budget + firm.** Rough USD ceiling for the third-party EVM audit, and
  do you have a preferred firm? (Spearbit and OpenZeppelin both have Base
  experience; Trail of Bits is gold-standard but slower + pricier.) This
  gates WP-EVM-16's calendar.
- **CCTP for treasury rebalancing.** Plan to use Circle CCTP for moving
  treasury USDC between chains (Solana ↔ Base ↔ Arbitrum), or stick with a
  manual ops process for v1?
- **Naming.** Confirm `@pact-network/protocol-evm-v1` for the Solidity
  package, sibling to the existing Solana `@pact-network/protocol-v1-client`?
  Or a different naming convention (e.g., `protocol-base-v1` /
  `protocol-arbitrum-v1` if we want chain-specific surfaces)?

---

## 10. References

- Solana on-chain (the thing being ported):
  `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/`
  - `state.rs` — account layouts mirrored in §3.
  - `instructions/settle_batch.rs` — settlement flow mirrored in §3.3.
  - `pda.rs` — PDA seeds; EVM equivalent in §2 row 2.
  - `error.rs` — error code allocation; EVM port should mirror numeric codes.
  - `discriminator.rs` — instruction slots; EVM uses function selectors instead.
- Off-chain wrap interface: `packages/wrap/src/wrapFetch.ts`.
- Indexer events ingest: `packages/indexer/src/events/`.
- Mainnet readiness pattern: `docs/audits/2026-05-05-mainnet-readiness.md`.
- Analytics dashboard groundwork (prior parallel doc):
  `docs/analytics/2026-05-15-dashboard-groundwork.md`.
