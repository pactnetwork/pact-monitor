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
protocol to **Ethereum mainnet first**, then extend to other EVM chains. The
core proposition is that "EVM" to most institutional integrators and treasury
underwriters means Ethereum L1 — the chain with the deepest USDC liquidity,
the canonical Circle issuance, and the audit-trail credibility that L2s do not
yet match.

This doc maps the Solana primitives we already use onto EVM equivalents, sketches
the Solidity contract shape, examines whether per-call insurance economics
survive on Ethereum L1 (spoiler: only with heavy batching, large premiums, or
off-chain accounting), and lays out the work needed without prescribing
implementation details that should be decided at WP time.

**Document version:** v2 — re-anchored on Ethereum-mainnet-first per Rick, with
honest L1 gas economics analysis. v1 led with Base/Arbitrum and treated
Ethereum as a later extension; that did not match Rick's intent.

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

### 4.1 Hard requirements

1. Canonical (or Circle-issued) USDC with 6 decimals.
2. Per-call gas cost reconcilable with premium economics — the v1 floor is
   100 lamports = $0.0001 USDC on Solana. **On Ethereum L1 this floor is not
   reachable;** §4.3 quantifies how much it has to move.
3. EOA-friendly UX so agents don't need to learn a new wallet stack
   (or a clean ERC-4337 paymaster path if we want USDC-only UX).
4. Mature tooling — Foundry, Etherscan, public RPC, established audit-firm
   familiarity.

### 4.2 Scoring (Ethereum mainnet primary)

Scoring (1 = poor, 5 = excellent). Rick's stated intent puts Ethereum mainnet
at the top; the table below scores it honestly rather than against the L2 set:

| Chain | USDC | Per-call gas economics | Ecosystem fit | Audit support | Bridge story | Total |
|---|---|---|---|---|---|---|
| **Ethereum mainnet** | 5 (native Circle USDC; deepest liquidity by 10x) | **2** (≈$3-7 per settled call at typical 15 gwei; only viable with massive batches or premiums >$5/call — see §4.3) | 5 (every audit firm, every wallet, every treasury) | 5 (gold standard) | 5 (CCTP origin) | **22** |
| **Base** | 5 (native, Circle) | 5 (~$0.001-0.01 per settled call) | 5 (Coinbase-aligned; agent dev community) | 5 (most-audited L2) | 5 (CCTP) | **25** |
| **Arbitrum** | 5 (native, Circle) | 5 | 5 (deep DeFi liquidity) | 5 | 5 (CCTP) | **25** |
| **Optimism** | 5 (native, Circle) | 5 | 4 | 5 | 5 (CCTP) | **24** |
| **Polygon PoS** | 3 (USDC.e legacy + native USDC since 2024) | 4 | 3 | 4 | 4 | **18** |
| **Polygon zkEVM** | 3 (native USDC limited) | 4 | 2 | 3 | 3 | **15** |
| **Linea** | 3 (Circle USDC live but lower liquidity) | 4 | 2 | 3 | 3 | **15** |
| **BNB Chain** | 4 (BSC-USD ≠ USDC; bridged USDC has lower trust) | 4 | 2 | 3 | 3 | **16** |

The numerical totals favor L2s **only because of the gas-per-call axis.** On
every other axis Ethereum mainnet ties or wins. The decision therefore reduces
to: **does the gas math work on L1, or does it not?** §4.3 answers that.

### 4.3 Ethereum L1 economics — worked example

The protocol's per-call debit is gas-hostile on L1. Below is an honest model of
what a settlement actually costs, so we can decide whether L1 is the primary
home or the prestige listing.

**Per-event gas budget inside `settleBatch`:**

| Operation | Gas (warm slots, typical) | Notes |
|---|---|---|
| `transferFrom(agent, pool, premium)` | 30,000-50,000 | Cold agent allowance the first time, warm after |
| Update `PoolState` (4-5 packed uint64 fields) | 5,000-15,000 | Warm storage slot per slug |
| Mark `settled[callId] = true` (cold SSTORE) | 20,000 | One-shot dedup mapping write |
| Fee fan-out to 1-3 recipients (`transfer`) | 30,000-90,000 | Cold dest the first time |
| Refund on breach (`transfer` from pool) | 0 or ~30,000 | Only when `breach = true` |
| Emit `CallSettled` event (LOG3, ~100 bytes data) | ~3,000 | Cheap |
| **Per-event total (no breach)** | **~88,000-178,000** | Mid-estimate ~110-130k |
| **Per-event total (with breach)** | **~118,000-208,000** | Mid-estimate ~140-160k |

Plus a fixed per-batch overhead of ~21,000 (tx base) + ~30,000 (calldata + role
check + first warm-up).

**Worked scenario — current Solana premium pattern ported as-is:**

Assumptions: ETH = $3,000, gas price = 15 gwei, premium per call = $0.001
(roughly the current v1 ceiling for low-cost endpoints), batch size = 50 calls,
~10% breach rate.

- Gas per batch: 21k + 30k + 50 × 120k = **~6.05M gas**
- Cost per batch: 6.05M × 15 gwei × $3,000 / 1e18 ETH = **≈ $272**
- Per-call gas overhead: $272 / 50 = **≈ $5.44 per call**
- Per-call premium revenue: $0.001
- **Loss per call: ~$5.44.** Pool is bled dry in days.

**Worked scenario — what would actually break even:**

Same assumptions, asking: at what point does premium income cover gas?

| Batch size | Gas/batch | Gas $/batch | Min premium for breakeven |
|---|---|---|---|
| 50 | 6.05M | ~$272 | ~$5.45 per call |
| 250 | 30M | ~$1,350 | ~$5.40 per call |
| 1,000 | 120M | exceeds block gas limit (~30M) | not feasible in one tx |
| 5,000 (split across batches) | 600M total | ~$27,000/day | ~$5.40 per call |

The per-call gas overhead is **roughly flat at ~$5/call** because the
bottleneck is per-event work (`transferFrom` + storage writes), not the
fixed batch overhead. **You cannot batch your way out of L1 gas.** Larger
batches just amortize the 21k tx base, which is already negligible.

**Implication:** Ethereum L1 only works for Pact in one of these regimes:

- **A. Premium ≥ ~$5 per call.** Insurance for high-value, low-frequency
  endpoints (e.g., a $50-per-query enterprise data API with a 10% premium).
  Most current Pact integrators are <$0.10/call retail APIs — they do not
  fit this regime.
- **B. Off-chain premium accumulation.** Agent's per-call premiums accrue
  off-chain in a signed receipt log (the settler tracks them); on-chain
  `settleBatch` runs hourly/daily and only settles **net positions** — one
  `transferFrom` per agent per period, one fee fan-out per endpoint per
  period. This collapses 10,000 per-call ops into ~10 net-position ops.
  Adds settler trust (the off-chain ledger must be auditable + slashable),
  adds a refund-finalization delay (agent waits for next settle window).
- **C. Hybrid.** Cheap calls go to L2 (Base/Arbitrum); high-value calls go
  to L1 for the audit-trail credibility. Same contract bytecode,
  per-chain endpoint routing in `EndpointConfig`.

### 4.4 Gas mitigations — full menu

In rough order of leverage on L1:

1. **Off-chain premium accumulation + periodic on-chain net settlement.**
   Highest leverage. Reduces L1 ops by 100-1,000x. Cost: settler becomes a
   trust point (mitigated by signed receipts + on-chain dispute window) and
   refund latency goes from per-call to per-period. Materially changes the
   protocol's claim of "every settlement on-chain" — see §4.5 caveat.
2. **Heavy batching.** Already in v1. Helps amortize fixed overhead but does
   nothing for per-event work; on L1 the per-event work *is* the cost. Cap
   useful batch size around block gas limit (~30M / 120k per event ≈ 250
   events max per tx). Modest leverage.
3. **Storage-slot packing tricks.** Pack `CallRecord` dedup into a `bitmap`
   instead of a `mapping(bytes16 => bool)` — replaces 20k SSTORE-zero-to-set
   with ~5k SSTORE-warm. Saves ~15k per call ≈ ~$0.70/call on L1. Useful but
   not transformative. Easy at WP time.
4. **ERC-4337 paymaster.** Lets agents pay gas in USDC instead of ETH. Does
   **not reduce gas; only shifts who pays.** Useful for UX (no native ETH
   required) but the same $5/call cost is still extracted from somewhere —
   typically the paymaster operator marks it up and bills the agent's USDC,
   so agents still effectively pay ~$5/call gas. Solves UX, not economics.
5. **EIP-7702 / smart-account sponsored flows.** Same UX win as paymaster
   without a separate contract; same economic limit.
6. **L2 fallback — deploy the same contracts on Base / Arbitrum.** The
   pragmatic escape hatch if L1 economics break for the customer base we
   actually have. Same Solidity, same audit, separate per-chain pool.

### 4.5 Recommendation — three options on the table

Rick's stated intent is Ethereum-mainnet-first. The honest read of the gas
economics produces three coherent options:

**Option A — Ethereum mainnet first, premiums sized for L1.**
Deploy on Ethereum L1. Set the protocol's effective minimum premium at
~$5/call, position Pact as an insurance layer for **enterprise / high-value
agent calls** (think: $20-200 per query, 5-10% premium). Layer in off-chain
premium accumulation (mitigation 1) so the L1 footprint is hourly/daily
settlements, not per-call settlements. Most ambitious; matches Rick's intent
literally; requires a major reframing of the Pact go-to-market away from
"insure every retail API call" toward "insure every high-value enterprise
agent transaction." Audit cost highest.

**Option B — Base first as the EVM beachhead, Ethereum mainnet second once
volume justifies.**
Deploy the same Solidity on Base, ship the demo there, prove out the indexer
and settler EVM paths, then deploy the **same contract bytecode** on Ethereum
mainnet for high-value endpoints once the off-chain accumulation work is in.
Treats Base as the L2 staging environment for the L1 contract. Lowest
implementation friction; gives integrators the choice; preserves Rick's
ultimate goal of Ethereum presence without forcing a go-to-market reframe in
the same release.

**Option C — Deploy on Ethereum + Base simultaneously from day 1.**
Same Solidity, same audit, two address registry entries. Endpoints register
per chain (or per chain set). Integrator picks based on their call value:
high-value retail and enterprise → Ethereum, micro-call retail → Base.
Internally we operate two pools with separate liquidity. Doubles the deploy
+ ops surface from day 1 but no extra contract work since the bytecode is
identical. Audit cost is one audit (single codebase) but two deployment
verifications.

**Recommendation: Option C, with the caveat that Ethereum endpoints must
launch with off-chain premium accumulation enabled (mitigation 1).**

Reasoning:
- Option A alone gambles the v1 EVM launch on a major product reframe in the
  same cycle as a chain port. Two big bets in one release is a
  documented anti-pattern for hackathon-cycle work and we already have a
  May 11 mainnet flip on the Solana side.
- Option B alone defers Rick's primary intent. He explicitly does not want
  "Base instead of Ethereum"; he wants Ethereum, with other chains as
  extensions.
- Option C honors Rick's intent (Ethereum from day 1) without forcing the
  premium-floor reframe to be the *only* answer — Base is there for
  endpoints that don't fit the L1 economics. Same Solidity, same audit
  scope, modest extra ops cost. Integrators self-select by chain based on
  their call value.

If Rick rejects "Base on day 1" entirely, fall back to **Option A** with
mitigation 1 as a launch blocker. **Do not ship L1 without off-chain premium
accumulation**; the "insurance for $0.001 calls" pattern simply does not
exist on Ethereum L1.

### 4.6 Multi-chain pool consolidation

Cross-chain rebalancing of pool USDC (Ethereum ↔ Base ↔ Arbitrum) can use
**Circle CCTP** — burns on source, mints on dest, no third-party bridge risk.
Treasury and integrator earnings withdraw separately per chain. See §5.

---

## 5. Cross-chain shape — multi-chain, not cross-chain

**Strong recommendation: independent deployments per chain, no bridging of
pool liquidity at the protocol level.** Same recommendation regardless of
which §4.5 option we pick — applies to Ethereum + Base + Arbitrum equally.

| Option | Description | Verdict |
|---|---|---|
| **A. Multi-chain independent** (recommended) | Each chain has its own `PactRegistry` + `PactPool` + `PactSettler`. Liquidity, endpoints, and call records are chain-local. Treasury and integrators withdraw separately per chain. | Simple, audit-friendly, no bridge attack surface. Each chain failure is contained. |
| **B. Cross-chain pool** | Pool liquidity on chain A backs calls served on chain B. Requires a messaging bridge (CCIP, LayerZero, Wormhole) to relay settlement events and unlock refunds. | Adds a CRITICAL trust assumption (the bridge). 2024-2025 saw multiple eight-figure bridge exploits. Not worth it for v1. |
| **C. Hub-and-spoke (Solana or Ethereum hub)** | One chain stays canonical; the other EVM chains are "spokes" that mirror state and emit intent. Settlement still happens on the hub. | Worst of both: agents on the spoke pay gas for nothing on-chain, and we still depend on a bridge. |

Multi-chain independent matches the product reality: an agent picks a chain
based on where its wallet + USDC live; the pool that insures the call lives on
the same chain. If the same integrator wants endpoints on Ethereum AND Base,
they `registerEndpoint` twice — once per chain — and treat them as separate
revenue streams. With §4.5 Option C this is the explicit pattern.

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

The WPs assume **§4.5 Option C** (Ethereum + Base from day 1). Single
codebase, single audit, two deployments. If Rick picks Option A (Ethereum
only) drop the Base-specific WPs (07b, 14b, 17b). If he picks Option B
(Base first, Ethereum later) reorder so the Ethereum-mainnet deploy moves
to the production-path tail.

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
   **L1-aware:** include the bitmap-packed dedup map from §4.4 mitigation 3
   from the start (cheap to add now, painful later).
5. **WP-EVM-05 — Settler hardening.** Exposure cap (hourly bucket per
   endpoint), `DelegateFailed` recovery via `try/catch` around `transferFrom`,
   `PoolDepleted` accounting, dedup via packed bitmap.
6. **WP-EVM-05b — Off-chain premium accumulation (NEW, L1 launch blocker).**
   Settler ledger of signed per-call receipts; `settleNetPositions(agent[],
   netDebit[], slug[])` instruction for periodic on-chain net settlement;
   on-chain dispute window for agents to challenge a recorded debit. Required
   before Ethereum mainnet launch under §4.5 Option A or C; not required for
   Base-only (Option B). See §4.4 mitigation 1.
7. **WP-EVM-06 — Foundry test suite.** Mirror the LiteSVM test plan from
   `pact-network-v1-pinocchio/tests/`. Fuzz the bps fan-out and exposure cap.
   Add gas-snapshot tests so per-call gas regressions get caught at PR time
   (`forge snapshot`).
8. **WP-EVM-07a — Deploy scripts + Sepolia deploy (Ethereum Sepolia).**
   `forge script` targeting Ethereum Sepolia. Operator runbook for
   `transferOwnership` to a Safe.
9. **WP-EVM-07b — Sepolia deploy (Base Sepolia).** Same `forge script` with
   a different RPC + chain-id. Verifies the bytecode is portable and the
   address registry pattern works.
10. **WP-EVM-08 — TS client (`protocol-evm-v1-client`).** ABI exports,
    per-chain address registry (Ethereum + Base entries from day 1), viem-based
    balance + allowance helpers, typed `settleBatch` + `settleNetPositions`
    wrappers.
11. **WP-EVM-09 — `wrap` `BalanceCheck.evm` implementation.** Reads
    `balanceOf` + `allowance` via viem. Pass-through into existing `wrapFetch`.
    Chain selected per endpoint config.
12. **WP-EVM-10 — `settler` `EvmSettlerAdapter`.** Behind a `ChainAdapter`
    interface. Per-chain submission queues; shared batcher + idempotency.
    Routing logic: cheap calls (premium < $1) get rejected on Ethereum
    endpoints with a clear error; routed to Base endpoints if integrator
    registered both.
13. **WP-EVM-11 — `indexer` per-chain event poller.** `eth_getLogs` (or viem
    `watchEvent`) for `CallSettled`, `PoolToppedUp`, `EndpointRegistered`.
    Two pollers (Ethereum + Base) writing to the same Postgres schema with a
    `chain` column.
14. **WP-EVM-12 — Postgres schema migration.** Add `chain` enum column to
    `Call`, `Settlement`, `PoolState`, `EndpointConfig`, `RecipientEarnings`.
    Backfill with `'solana'` for existing rows. Enum members:
    `solana | ethereum | base | arbitrum`.
15. **WP-EVM-13 — `market-dashboard` chain switcher.** Drop-down in the
    dashboard header; per-chain filter on all stats panels. "Show Ethereum
    pools" defaulted on so Rick's primary intent is the visible default.
16. **WP-EVM-14a — Ethereum Sepolia demo end-to-end.** Real agent calls a
    real high-value insured endpoint on Ethereum Sepolia (premium ≥ $5/call
    so the economics demonstrate cleanly), settler runs net-position
    settlement hourly, breach triggers refund within the next window,
    dashboard shows the call labeled "Ethereum". **Primary demo-gate.**
17. **WP-EVM-14b — Base Sepolia demo end-to-end.** Same agent, same flow,
    but a low-cost retail endpoint on Base Sepolia with per-call settlement.
    Demonstrates the "L2 fallback for cheap calls" narrative.
18. **WP-EVM-15 — Audit prep + Safe rotation.** Mainnet readiness audit doc
    for the EVM contracts; same format as
    `docs/audits/2026-05-05-mainnet-readiness.md`. Add an
    L1-economics-blocker section noting the ~$5/call gas floor and the
    off-chain accumulation requirement. Rotate deployer EOA → Safe multisig
    on both chains.
19. **WP-EVM-16 — Third-party audit window.** One firm (Spearbit / Trail of
    Bits / OpenZeppelin). Hold mainnet deploy until written report + fix-PR.
    Audit covers the bytecode that ships to *both* chains — single audit,
    two deployment verifications.
20. **WP-EVM-17a — Ethereum mainnet deploy.** Primary chain per Rick's intent.
21. **WP-EVM-17b — Base mainnet deploy.** L2 fallback for cheap calls.
22. **WP-EVM-18 — Arbitrum mainnet deploy (deferred).** Same contract
    bytecode; new addresses; new entry in the address registry. Not
    launch-blocking; ship after we have one full ops cycle on Ethereum + Base.

WP-01..WP-14b is the demo path. WP-15..18 is the production path. WP-05b is
a launch blocker for Ethereum specifically; it can be skipped if Rick picks
Option B (Base-only initial launch).

---

## 9. Open questions for Rick

Tight list — each is load-bearing for the WP plan.

- **Chain priority — pick one of three (replaces v1 Q1).**
  Per the §4.5 analysis, your "Ethereum first" intent collides with L1 gas
  economics (~$5/call gas overhead, regardless of batch size). Options:
  - **A.** Ethereum mainnet only. Requires repositioning Pact toward
    high-value enterprise calls (premium ≥ $5/call) and shipping off-chain
    premium accumulation (WP-EVM-05b) as a launch blocker.
  - **B.** Base mainnet first as the EVM beachhead, Ethereum mainnet
    follow-on once volume justifies. Lowest implementation friction; defers
    your stated primary intent.
  - **C.** Ethereum + Base from day 1 (recommended). Same Solidity, same
    audit, two deployments. Integrators self-select per chain by call value.
    Honors Ethereum-first intent without forcing the premium reframe.

- **Per-call gas / minimum-premium ceiling (NEW).**
  What's the maximum acceptable per-call gas cost for an Ethereum-side
  insured call, expressed either as $ per call or as a fraction of the
  premium? And what's the minimum premium you're willing to enforce on
  Ethereum endpoints? The §4.3 worked example assumes ~$5/call gas at 15
  gwei — is that acceptable for any meaningful slice of the integrator
  pipeline, or does the answer force us into Option B?

- **Off-chain premium accumulation.**
  If we go Option A or C, do you accept the trust tradeoff that on Ethereum
  the settler holds signed per-call receipts off-chain and only settles
  net positions on-chain hourly/daily? This breaks the literal "every
  settlement on-chain" claim from the Solana product and replaces it with
  "every settlement is on-chain provable, with a dispute window." Mitigated
  by signed-receipt verification + on-chain dispute period, but it is a
  product-level shift worth your explicit signoff.

- **Mainnet vs testnet first.** Demo on Sepolia (Ethereum + Base both)
  end-to-end before spending audit budget? (Recommended.) Or push straight
  to mainnet with a fresh audit?

- **Gasless / paymaster option.** Do agents on EVM pay their own gas, or
  do we offer a sponsored UX via ERC-4337 paymaster so the agent flow is
  "USDC in, USDC out, no ETH"? Note from §4.4: paymasters fix UX (no
  native-ETH requirement) but **do not change L1 economics** — the gas
  cost is still extracted from someone, typically marked-up against the
  agent's USDC. Useful but not a fix for the L1 gas problem. Recommend
  yes-on-Base for UX, optional-on-Ethereum given the call-value tier.

- **Pool bridging.** Confirm **independent per-chain pools** (no bridging
  of liquidity)? Or do you want a hub-and-spoke design? (Strong
  recommendation: independent, regardless of which Option A/B/C you pick.)

- **Audit budget + firm.** Rough USD ceiling for the third-party EVM audit,
  and do you have a preferred firm? (Spearbit and OpenZeppelin both have
  Base + Ethereum experience; Trail of Bits is gold-standard but slower +
  pricier. Sherlock / Cantina contest model is cheaper but slower to
  schedule.) This gates WP-EVM-16's calendar.

- **CCTP for treasury rebalancing.** Plan to use Circle CCTP for moving
  treasury USDC between chains (Solana ↔ Ethereum ↔ Base), or stick with a
  manual ops process for v1?

- **Naming.** Confirm `@pact-network/protocol-evm-v1` for the Solidity
  package (chain-agnostic), sibling to the existing Solana
  `@pact-network/protocol-v1-client`? Or a different naming convention
  (e.g., `protocol-eth-v1` / `protocol-base-v1` if you want chain-specific
  surfaces)? Recommend the chain-agnostic name since the bytecode is
  shared.

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
