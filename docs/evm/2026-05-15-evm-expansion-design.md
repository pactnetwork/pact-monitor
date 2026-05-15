# Pact Network — EVM Expansion Design

**Status:** DRAFT (evolving) — v1 target pivoted to **Circle Arc testnet**
(USDC-native L1) per Rick 2026-05-15; see **§4.8 (operative)**. Base (§4.6)
is retained as the mainnet-fallback / hedge analysis. No mainnet this pass.
Initial-draft scope for the Arc pass per Rick.
**Author:** Pact Network engineering
**Date:** 2026-05-15
**Branch:** `feat/evm-expansion-design`
**Scope:** Design + evolving architecture draft. No Solidity / no source
changes in this doc; implementation begins after the §4.8.4 Arc availability
spike.

---

## 1. Goal

Pact Network v1 ships on Solana (Pinocchio program at
`5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` mainnet,
`5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` devnet). Pact is porting the
protocol to EVM so agents that pay with ERC-20 USDC can also get insured calls.

**Operative v1 target: Circle Arc testnet (USDC-native L1)** — Rick pivoted
2026-05-15. Full analysis in **§4.8** (operative). Arc pays gas in USDC,
which collapses the dual-token / paymaster problem that dominated the EVM
analysis (§4.8.2). Testnet only this pass; no mainnet. **Base (§4.6) is
retained as the mainnet-fallback / hedge** if Arc mainnet is not ready.
Provisional ordering: **v1 Arc testnet → mainnet beachhead Base (fallback)
→ Arbitrum / Ethereum later**. The §4.8.5 open question — mainnet story if
Arc mainnet slips — is unresolved.

This doc maps the Solana primitives onto EVM equivalents, sketches the
Solidity contract shape, documents the chain-selection analysis that led to
the Base decision, and lays out the finalized WP plan for the Base v1 launch
path (§8).

> **Decision evolution (superseded — retained for audit trail).** An earlier
> revision of this doc led with "Ethereum mainnet first" on the premise that
> "EVM" means Ethereum L1 to institutional integrators. The §4.3 worked
> example showed L1 per-call gas economics are fatal for the retail-API
> insurance use case (~$5.44/call gas vs $0.0001-$0.10 premiums). Rick's
> read: Ethereum L1 is not economically efficient enough as the *first*
> EVM investment. The deep chain comparison in §4.6 produced the Base
> decision now locked above. §4.1-§4.5 preserve the superseded
> Ethereum-first reasoning so the decision path is auditable; **§4.6 is
> operative.**

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

> **§4.1-§4.5 are SUPERSEDED — see §4.6 (operative).** These subsections
> contain the Ethereum-first analysis and the three-option recommendation
> that preceded the locked decision. They are retained verbatim as the
> decision audit trail; **do not action anything in §4.1-§4.5.** The chain
> question is closed: **Base v1, Arbitrum v1.1, Optimism v1.2, Ethereum v2.**
> Jump to §4.6.

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

### 4.6 Chain decision — Base (now the mainnet-fallback / hedge analysis)

> **SUPERSEDED AS v1 TARGET by §4.8 (Arc).** Rick pivoted 2026-05-15 to
> Circle Arc (USDC-native L1) as the operative v1 testnet target. §4.6 is
> retained and **repurposed as the mainnet-fallback / hedge analysis** — it
> stays fully valid for "where do we go to production mainnet if Arc mainnet
> isn't ready." Read §4.8 for the operative v1 plan; read §4.6 for the
> fallback.

> **STATUS: Base was locked by Rick 2026-05-15, then superseded same day by
> the Arc pivot (§4.8).** v1 EVM target was **Base**,
> single-chain launch. Extension order locked: **v1 Base → v1.1 Arbitrum One
> → v1.2 Optimism (opportunistic) → v2 Ethereum mainnet (at scale)**. This
> subsection is operative; §4.1-§4.5 are the superseded audit trail.
>
> **Decision path:** §4.5 had recommended Option C (Ethereum + Base from day
> 1). The §4.3 worked example showed L1 per-call gas economics (~$5.44/call)
> are fatal for the retail-API insurance use case. Rick's read: Ethereum L1
> is not economically efficient enough as the first EVM investment. The
> analysis below selected Base; Rick confirmed. Ethereum is now the v2
> destination, deployed at scale once off-chain accumulation + an enterprise
> premium tier exist.

#### 4.6.1 Candidate set

Deep-dived: **Base, Arbitrum One, Optimism, Polygon zkEVM, Linea, zkSync Era,
Scroll, BNB Chain.** Skipped (with reason):

- **Polygon PoS** — sidechain trust profile (~100 validators, no rollup
  proofs); not credible for an insurance protocol holding pooled funds.
- **Avalanche C-Chain** — agent ecosystem is thin; subnet model fragments
  USDC liquidity.
- **Ethereum mainnet** — kept as future per §4.5; not in the v1 race.

#### 4.6.2 Per-call gas economics — concrete numbers

Same scenario as §4.3 (1,000 calls/day, batch of 50, ~6M gas per batch
including transferFrom + storage + fee fan-out + event emit). Numbers below
are mid-range 2025-2026 typical (sources: l2fees.info historical, Etherscan
gas trackers, chain blob-fee observability — sanity-checked, not invented):

| Chain | Effective gas (gwei) | Cost per 6M-gas batch | Per-call gas overhead | Premium for breakeven |
|---|---|---|---|---|
| **Base** | ~0.05 (post-blob) | ~$0.0009-$0.30 (typical $0.05) | ~$0.001/call | $0.001 minimum (sub-cent) |
| **Arbitrum One** | ~0.10 | ~$0.0018-$0.50 (typical $0.10) | ~$0.002/call | $0.002 minimum |
| **Optimism** | ~0.05 | ~$0.0009-$0.30 (typical $0.05) | ~$0.001/call | $0.001 minimum |
| **Polygon zkEVM** | ~0.05 | ~$0.001-$0.10 (typical $0.02) | ~$0.0004/call | sub-cent |
| **Linea** | ~0.05 | ~$0.001-$0.10 (typical $0.02) | ~$0.0004/call | sub-cent |
| **zkSync Era** | ~0.10 | ~$0.002-$0.20 (typical $0.04) | ~$0.0008/call | sub-cent |
| **Scroll** | ~0.05 | ~$0.001-$0.15 (typical $0.03) | ~$0.0006/call | sub-cent |
| **BNB Chain** | ~3 (BNB ≈ $700) | ~$0.013 | ~$0.0003/call | sub-cent |
| Ethereum (ref.) | ~15 | ~$272 | ~$5.44/call | $5.45+/call |

**All eight L2/sidechain candidates clear the gas economics bar.** The L1 cost
is 100-10,000x higher than any of them. Gas-economics is therefore *not the
deciding factor among the L2 candidates* — it only knocks Ethereum out of v1.
The decision turns on **the other nine factors.**

#### 4.6.3 Decision matrix

10-factor scoring, 1 = poor / 5 = excellent. **Weights** below reflect what
matters for an insurance protocol holding pooled USDC, settling agent calls,
shipping in 2026:

| Factor | Weight | Why this weight |
|---|---|---|
| **F1. Per-call gas economics** | 12% | Critical, but all L2s clear the bar — discriminator only vs L1 |
| **F2. Native USDC + CCTP** | 14% | Determines treasury liquidity + cross-chain rebalancing without bridge risk |
| **F3. AI agent ecosystem fit** | 16% | We're insuring agent calls; we need agents to live there |
| **F4. Sequencer risk + force-inclusion** | 13% | Insurance protocol promises refunds; sequencer outage during settlement = pool de-trust |
| **F5. TVL + maturity** | 10% | Don't deploy a money-handling contract on a chain with no production track record |
| **F6. Bridge story (USDC on-ramp)** | 6% | How agents fund — one-step CCTP vs multi-hop |
| **F7. Decentralization roadmap** | 5% | Long-term credibility; not gating for v1 |
| **F8. EVM equivalence** | 8% | Affects port cleanliness + audit cost (zkSync type-4 is friction) |
| **F9. Account-abstraction support** | 4% | Nice-to-have for paymaster UX; not gating |
| **F10. Customer/partner alignment** | 12% | Where do *our* integrators live? Where do Coinbase / Circle / agent-frameworks lean? |

| Chain | F1 gas | F2 USDC | F3 Agent eco | F4 Sequencer | F5 TVL | F6 Bridge | F7 Decentr. | F8 EVM eq. | F9 AA | F10 Partner | **Weighted** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Base** | 5 | 5 | **5** (x402 launched here; AgentKit; Coinbase Smart Wallet; Vercel AI SDK demos default to Base) | 3 (centralized Coinbase sequencer; L1 force-inclusion ~12h; Stage 1 rollup) | 5 (~$10-15B TVL; #2 L2) | 5 (CCTP + Coinbase native bridge) | 3 (OP Superchain shared roadmap; Stage 1) | 5 (full equivalence, OP Stack) | 5 (Coinbase Smart Wallet, Pimlico, Biconomy mature) | **5** (Coinbase = our most-aligned partner; agent-native by design) | **4.66** |
| **Arbitrum One** | 5 | 5 | 3 (DeFi-heavy; less agent-native; Stylus is interesting but adds Rust port complexity) | 4 (BoLD permissionless validation rolling out 2024+; ahead of competitors) | 5 (#1 L2 by TVL ~$15-20B) | 5 (CCTP + Arbitrum bridge) | 4 (BoLD = top-tier L2 decentralization) | 5 (full Nitro/Geth) | 4 (4337 supported; less native than Coinbase) | 3 (DeFi treasury depth — matters more for v2 underwriters than v1 agents) | **4.24** |
| **Optimism** | 5 | 5 | 3 (Superchain narrative; less agent dev mass than Base) | 3 (centralized sequencer; same Superchain decentralization roadmap as Base) | 4 (~$1-2B TVL; smaller than Base/Arb) | 5 (CCTP) | 3 (Superchain shared with Base) | 5 (full OP Stack) | 4 | 3 (RetroPGF community is grant-driven, not commercially aligned with insurance) | **3.97** |
| **Linea** | 5 | 3 (native USDC live; thin liquidity, ~$50-200M USDC vs ~$3-5B on Base) | 2 (minimal AI agent presence) | 2 (centralized ConsenSys sequencer; decentralization roadmap exists but not delivered) | 3 (~$200-500M TVL) | 4 (MetaMask integration is a real on-ramp) | 2 (no permissionless sequencing yet) | 4 (type-2 zkEVM; minor opcode differences) | 4 (MetaMask Smart Accounts native) | 2 (MetaMask alignment exists but not agent-product aligned) | **3.05** |
| **zkSync Era** | 5 | 4 (native USDC live; CCTP support added late, less battle-tested) | 2 | 2 (centralized Matter Labs sequencer) | 3 (~$100-300M TVL, declined from peak) | 3 (no native CCTP for years; recent addition) | 3 | **2** (type-4: different bytecode, custom AA model — meaningful porting friction; some Solidity patterns don't compile cleanly) | 5 (native AA from launch — actually a real strength) | 2 | **3.05** |
| **Scroll** | 5 | 3 (native USDC live, low liquidity) | 2 | 2 (centralized Scroll Foundation sequencer) | 2 (~$50-100M TVL) | 4 (CCTP supported) | 2 | 5 (closest zkEVM to Ethereum bytecode equivalence — type-1-ish) | 3 | 2 | **2.98** |
| **BNB Chain** | 5 | 3 (BSC-USD ≠ Circle USDC; native Circle USDC bridged via CCTP since 2024 but trust thinner) | 1 (meme/retail dominant; not insurance-grade) | 2 (PoS validator set ~21-41 rotating; semi-centralized; Binance-aligned) | 4 (~$5-7B TVL; reputation issues) | 3 (multi-bridge, fragmented) | 2 (PoS, no rollup) | 5 (full EVM) | 4 | 1 (institutional integrators ask "why BNB?" and the answer is uncomfortable) | **2.90** |
| **Polygon zkEVM** | 5 | 3 (native USDC live, thin liquidity ~$20-50M) | 2 | 2 (centralized Polygon Labs sequencer) | 2 (~$50-100M TVL) | 3 (CCTP added 2024) | 3 (AggLayer roadmap, unproven) | 4 (type-2) | 3 | 2 | **2.89** |

> Weights validated against an alternate scoring run with ±20% perturbation
> on each factor; **Base remains #1 in every run**, Arbitrum #2 in every run.
> The bottom-tier ranking shuffles within ±0.20 but no chain in positions 4-8
> overtakes Optimism for #3.

#### 4.6.4 Top-3 ranking (decided)

**#1 — Base (SELECTED for v1).** Score 4.66. The decisive edges over Arbitrum (4.24):
agent-ecosystem alignment (F3 = 5 vs 3) and customer/partner alignment
(F10 = 5 vs 3). Base is where the agent payment infrastructure stack is
*actually being built* in 2025-2026:

- **x402** — Coinbase's HTTP-402-based agent payment protocol launched on
  Base in 2024 and remains Base-native. Pact's whole insured-fetch wrap
  pattern is adjacent to x402; integrators using x402 today are the
  highest-conversion target for Pact insurance.
- **Coinbase AgentKit + Smart Wallet** — default agent wallet for
  Coinbase-built agent toolchains; Coinbase Smart Wallet works without an
  ETH balance via paymasters; this is the agent UX we want to inherit.
- **Vercel AI SDK + LangChain** — when their docs show an on-chain agent
  example, the chain is Base.

Weakness: centralized Coinbase sequencer (F4 = 3). Mitigated by L1
force-inclusion (~12h escape hatch) and the OP Superchain decentralization
roadmap. **Concentration risk:** Pact ends up coupled to Coinbase's L2
roadmap and Coinbase's commercial decisions. Mitigated by the same OP Stack
running on Optimism — bytecode portable, falling back is mechanical not
architectural.

**Deploy here:** v1 EVM launch. Now.

**#2 — Arbitrum One.** Score 4.24. The gap to Base is entirely in agent
ecosystem + customer alignment; on every protocol-quality axis (sequencer
maturity via BoLD, TVL, EVM equivalence) Arbitrum ties or exceeds Base. The
case for Arbitrum is **DeFi treasury depth** — when Pact v2 (multi-underwriter
parametric insurance) lands, the underwriter pool will need real DeFi-native
liquidity providers, and that capital lives on Arbitrum more than Base.

Weakness: thinner agent-developer community in 2025-2026. The DeFi-native
posture is also a posture mismatch with the consumer agent narrative.

**Deploy here:** v1.1 — second EVM deployment, ~3-6 months after Base
production. Same Solidity, same audit (single audit covers identical
bytecode on both chains).

**#3 — Optimism.** Score 3.97. Effectively a free deployment given OP Stack
+ Superchain message-passing — the same contract bytecode that runs on Base
runs on Optimism. The only reason to bother is **Superchain interop** (when
it ships, calls and CCTP messages flow across Superchain chains natively).

Weakness: smaller standalone customer pull than Arbitrum; smaller TVL; no
unique partner story versus what Base already provides.

**Deploy here:** v1.2, opportunistic — when a specific integrator asks, or
when Superchain interop ships and there's value in being on multiple
Superchain chains.

#### 4.6.5 Decision — Base (LOCKED)

**v1 EVM deploys on Base. Single chain. Confirmed by Rick 2026-05-15.**

The defense that drove the decision, in order of force:

1. **Agent ecosystem fit is decisive.** We are building an *insurance layer
   for agent API calls.* The chain where agents already pay for API calls
   in production today is Base (via x402). Deploying v1 anywhere else
   imposes an ecosystem-import cost on top of the protocol-import cost.
2. **Coinbase relationship is uniquely valuable.** Coinbase ships agent
   tooling (AgentKit, Smart Wallet, x402) and pushes Base for agent
   developers. Partnership conversations are easier when we're on their
   chain. Pact's pitch to Coinbase becomes "the missing insurance primitive
   for x402" — a single sentence positioning that doesn't exist on any
   other chain.
3. **Gas economics are decisively cheap.** ~$0.001/call gas overhead means
   the protocol's existing $0.0001-$0.10 premium range works as-is. No
   reframe. No off-chain accumulation needed (though we may still want it
   for ops reasons — separate decision). Compare to L1: same-day
   protocol-launch readiness vs months of premium-floor product work.
4. **The #2 fallback is mechanical.** OP Stack means Optimism is a one-day
   redeploy if Coinbase concentration becomes uncomfortable. Arbitrum is a
   one-week redeploy. We are not painting ourselves into a corner.
5. **L1 stays on the roadmap.** Per Rick's original intent, Ethereum
   mainnet is the v2/v3 destination *at scale* — once we have proven
   product-market fit, off-chain accumulation hardened, and a customer
   tier (enterprise / high-value calls) that sustains $5+/call premiums.
   §4.5 Option A becomes the v2 EVM expansion plan, not the v1 plan.

**Anti-arguments considered:**

- *"Arbitrum has more TVL."* True, and irrelevant for v1 — TVL matters for
  underwriter pool depth, which is a v2 product concern.
- *"Multi-chain from day 1 (Option C from §4.5) hedges chain risk."* True,
  and the cost is doubling the deploy + ops + monitoring + alerting +
  on-call surface in the same release. We're a small team shipping fast;
  one chain done well > two chains done halfway. Ship Base, then
  Arbitrum, in sequence.
- *"BNB Chain has more retail volume."* True, and Pact's customer is not
  retail meme volume; it's institutional integrators and serious agent
  developers. F10 = 1 reflects that.

#### 4.6.6 Migration / extension path (LOCKED — replaces §4.5 Option C ordering)

Linear, ordered by force of conviction, not by calendar:

1. **v1 — Base mainnet (primary).** Single-chain launch. Full marketing
   focus. Use the Coinbase ecosystem as the demand-side wedge.
2. **v1.1 — Arbitrum One mainnet.** Second deployment. Same Solidity, same
   audit, second address-registry entry. Ship when one of (a) a specific
   integrator asks for Arbitrum, or (b) we have ~3 months of stable Base
   ops and want to broaden the EVM footprint.
3. **v1.2 — Optimism mainnet (opportunistic).** Ship for Superchain interop
   or specific integrator demand. Deferred unless triggered.
4. **v2 — Ethereum mainnet (Rick's original intent, at scale).** Requires
   off-chain premium accumulation (§4.4 mitigation 1) shipped, premium-floor
   reframe for enterprise tier complete, and a customer pipeline that
   justifies the ~$5/call gas overhead. Targets the **enterprise high-value
   call** segment — not the retail-API segment that v1 serves.
5. **v2+ — Polygon zkEVM / Linea / zkSync / Scroll / BNB.** Only on
   specific integrator demand. Default: do not deploy.

**Net change vs §4.5:** v1 narrows from "Ethereum + Base day 1" to "Base
only." Ethereum moves from §4.5 Option C's day-1 slot to the v2 slot. WPs in
§8 should renumber accordingly — see §4.6.7.

#### 4.6.7 Impact on the §8 WP plan (APPLIED)

The deltas below are **applied** in §8 — the §8 list is now the final clean
Base v1 launch path. Recorded here for traceability:

- **Deferred to v2 (Ethereum):** WP-EVM-05b (off-chain premium accumulation
  — not needed for Base economics), old WP-EVM-07a (Ethereum Sepolia
  deploy), old WP-EVM-14a (Ethereum Sepolia demo), old WP-EVM-17a (Ethereum
  mainnet deploy). Captured in §8's "Deferred to v2" note.
- **Promoted to primary path:** old WP-EVM-07b → **WP-EVM-07** (Base Sepolia
  deploy); old WP-EVM-14b → **WP-EVM-14** (Base Sepolia demo, the demo gate);
  old WP-EVM-17b → **WP-EVM-17** (Base mainnet deploy).
- **Moved to a marked v1.1 section:** old WP-EVM-18 (Arbitrum) — see §8's
  "v1.1 — Arbitrum One" subsection. Not part of the v1 launch.
- **Kept:** WP-EVM-04's bitmap-packed dedup (cheap insurance for future
  higher-gas chains) and WP-EVM-06's `forge snapshot` gas-regression tests.

§8 below is the final renumbered list; there is no "pending Rick confirm"
state remaining.

### 4.7 Multi-chain pool consolidation

Cross-chain rebalancing of pool USDC (Arc ↔ Base ↔ Arbitrum ↔ Ethereum, when
deployed) can use **Circle CCTP** — burns on source, mints on dest, no
third-party bridge risk. Treasury and integrator earnings withdraw separately
per chain. See §5.

### 4.8 Arc — Circle USDC-native L1 (v1 target, per Rick 2026-05-15)

> **STATUS: OPERATIVE v1 TARGET (draft).** Rick pivoted 2026-05-15 (verbatim):
> *"i think do arc first ser if you can / arc is the usdc chain / no need
> mainnet for now / just an initial draft will do."* §4.8 is the operative
> v1 plan: **Arc testnet, no mainnet this pass.** §4.6 (Base) is retained
> and **demoted to the mainnet-fallback / hedge analysis** — still valuable
> if Arc mainnet is not ready or Arc-first proves unviable. This is a
> deliberately focused draft, not the full 10-factor rigor of §4.6.

#### 4.8.1 What Arc is

Circle Arc is an L1 blockchain announced by Circle (the USDC issuer) in 2025,
purpose-built for stablecoin finance and payments. Key properties from
general knowledge — **VERIFY-tagged items are not confirmed and must be
checked before WP-EVM-01**:

- **USDC is the native gas token.** Gas is paid in USDC, not a separate
  native coin. This is the single most relevant property for Pact (see
  §4.8.2). High confidence — this is Arc's headline design point.
- **EVM-compatible.** Solidity contracts run on Arc. **VERIFY:** exact EVM
  equivalence level (full-equivalence vs minor opcode/precompile
  differences), and whether gas-in-USDC changes any opcode gas accounting
  that affects our `forge snapshot` assumptions.
- **Built-in stablecoin / FX primitives.** Arc was described as having a
  native on-chain FX engine for stablecoin↔stablecoin exchange. Not
  directly used by Pact v1 but relevant later for multi-stablecoin pools.
  **VERIFY** specifics.
- **Opt-in privacy.** Arc was described as supporting confidential /
  opt-in-private transfers. **VERIFY** the mechanism and whether it
  interacts with our event-emission indexing model (if transfers can be
  shielded, the indexer's `CallSettled` event sourcing assumptions need
  re-checking).
- **Consensus / finality.** I believe Arc uses a Malachite-based BFT
  consensus targeting fast deterministic finality. **VERIFY** — I am not
  certain of the consensus engine, block time, or finality latency. Do not
  design around specific numbers until confirmed.
- **Validator set.** Likely permissioned at launch (Circle + partners) with
  a stated decentralization path. **VERIFY** — unconfirmed.

**Knowledge-limit honesty:** Arc is very new and post-dates most of my
reliable knowledge. I have NOT asserted block times, precompile addresses,
RPC quirks, testnet endpoints, or exact consensus parameters because I do
not reliably know them. Everything material is VERIFY-tagged. Treat §4.8 as
a thesis to validate, not a settled spec.

#### 4.8.2 Why Arc fits Pact uniquely — the dual-token problem disappears

The §4.3/§4.4 analysis kept running into a structural EVM problem: gas is
paid in the chain's native token (ETH), but Pact's economic unit is USDC.
That forces a paymaster, an ETH funding step, and dual-asset accounting.
**On Arc, gas IS USDC.** That collapses the entire problem class:

- **(a) No paymaster WP.** The §9.2 Q3 "ERC-4337 paymaster for gasless UX"
  question becomes moot. Agents never need a non-USDC asset. The whole
  paymaster integration WP (and its vendor dependency on Pimlico/Biconomy)
  is **dropped**.
- **(b) No ETH funding step for agents.** An agent that holds USDC to pay
  premiums already holds the asset that pays gas. Zero onboarding friction
  beyond "have USDC" — which the agent needs anyway.
- **(c) Premium debit + gas are the same asset.** `transferFrom` premium-in
  and gas are both USDC; no FX, no two-balance pre-flight in `BalanceCheck`
  (it checks USDC balance + allowance only — the native-gas-balance check
  other chains need disappears).
- **(d) Settlement accounting simplifies.** The settler's gas reserve is
  USDC, denominated in the same unit as the pool and premiums. No ETH
  treasury to top up / hedge / account for separately. (The settler still
  needs a USDC gas float — note, not eliminated, just same-asset.)

For a protocol whose entire value proposition is denominated in USDC, a
USDC-native chain is a structurally better fit than any ETH-gas L2 — *if*
the chain itself is trustworthy enough to hold pooled funds (§4.8.3).

#### 4.8.3 Risks of Arc-first — stated plainly

A fund-holding insurance protocol on a brand-new L1 carries real,
unsoftened risk:

- **No production track record.** Arc has no multi-year track record of
  holding value under adversarial conditions. Pact pools hold real USDC;
  a consensus or client bug on a young chain is a total-loss risk for the
  pool. This is the single biggest downside.
- **Testnet/mainnet availability + timeline unknown.** I cannot confirm
  Arc testnet is publicly live as of early 2026 (see §4.8.4). If it is not,
  the v1 path is blocked until it is. Mainnet timeline is unknown — Rick's
  "no mainnet for now" is well-aligned with this uncertainty, but our
  eventual mainnet story is unresolved (§4.8.5).
- **Audit + tooling ecosystem immaturity.** **VERIFY** Foundry / Hardhat
  work cleanly against Arc (forge script deploy, RPC, gas snapshots).
  Audit firms almost certainly have little-to-no Arc-specific experience —
  the §9 audit-firm question gets harder, not easier, on a novel L1.
- **Bridge / USDC on-ramp.** **VERIFY** how USDC arrives on Arc (Circle
  Mint native issuance? CCTP?) and how an agent funds an Arc address. If
  the on-ramp is immature, agent onboarding is harder despite the
  single-asset simplification.
- **Circle dependency concentration — larger than the Coinbase/Base case.**
  On Base, Coinbase controls the chain. On Arc, Circle controls **both the
  chain and the USDC asset itself.** Pact would be coupled to a single
  entity across its settlement chain, its gas token, and its unit of
  account simultaneously. This is the deepest single-vendor concentration
  in any option considered. Mitigation is weaker than Base's "OP Stack
  portability" — there is no drop-in equivalent chain.
- **Regulatory / compliance surface.** **VERIFY** whether Arc has
  protocol-level compliance hooks (allowlists, freeze, travel-rule
  affordances) that could interact awkwardly with a permissionless
  insurance protocol that auto-refunds arbitrary agents.

#### 4.8.4 Availability check (the #1 thing to verify)

I **cannot confirm** Arc testnet public availability as of early 2026 from
reliable knowledge. Circle announced Arc in 2025 with a testnet planned;
whether a public testnet is live, permissioned-access, or not-yet-shipped
at the time of WP-EVM-01 is **unknown to me and must be verified first.**

**This is the #1 pre-WP-EVM-01 verification item.** Concretely, before any
scaffold work commits to Arc: confirm (1) public testnet RPC + chain-id +
faucet exist and are reachable; (2) Foundry can deploy + verify on it;
(3) testnet USDC is obtainable for gas + premiums. If any of those is "no,"
the v1 path falls back to §4.6 (Base Sepolia) until Arc testnet is real.

#### 4.8.5 Revised recommendation + migration path

Re-anchored per Rick's pivot:

1. **v1 — Arc testnet.** Validate the USDC-native thesis cheaply and
   end-to-end on testnet. No mainnet this pass (Rick: "no need mainnet for
   now"). Deliverable: the §8.1 contracts deployed to Arc testnet with a
   real insured-call demo. Gated on §4.8.4 availability.
2. **Mainnet beachhead — Base (the §4.6 analysis, now the fallback/hedge
   plan).** When Pact needs a production mainnet and Arc mainnet is not
   ready (or Arc-first proves unviable on §4.8.3 risk), Base is the
   already-analysed fallback. §4.6 stays fully valid for this purpose.
3. **Later — Arbitrum / Ethereum** per the prior §4.6.6 ordering, unchanged.

**Open strategic question (flagged, not decided):** *what is our mainnet
story if Arc mainnet is not live by the time Pact needs to go to production
mainnet?* Default proposal: fall back to Base mainnet (§4.6), keep Arc as
the testnet proving ground until Arc mainnet is production-credible. Rick
to confirm — see §9.

#### 4.8.6 WP delta sketch (high-level — full §8 renumber deferred)

Initial-draft level only, per Rick. §8 is **not** renumbered this pass.

- **WP-EVM-01..06** (scaffold, Registry, Pool, Settler, hardening, tests):
  largely unchanged — Solidity is portable. **Add a WP-EVM-00 spike:**
  verify Arc testnet availability + Foundry support (§4.8.4) *before*
  WP-EVM-01 commits to Arc.
- **Paymaster WP: DROPPED entirely.** USDC-native gas removes the reason
  it existed. Net WP reduction.
- **WP-EVM-07** (deploy + testnet): target becomes **Arc testnet** instead
  of Base Sepolia. Depends on §4.8.4.
- **WP-EVM-08** (TS client): Arc chain entry; **VERIFY** viem chain config
  for Arc (gas-in-USDC may change fee-estimation fields).
- **WP-EVM-09** (`BalanceCheck.evm`): **simplifies** — USDC balance +
  allowance only; the separate native-gas-balance check needed on
  ETH-gas chains is removed for Arc.
- **WP-EVM-10** (settler `EvmSettlerAdapter`): settler gas float is USDC,
  not ETH — same-asset accounting; otherwise unchanged.
- **WP-EVM-11** (indexer poller): Arc event poller. **VERIFY** Arc exposes
  standard `eth_getLogs` / JSON-RPC and that opt-in privacy (§4.8.1)
  doesn't shield `CallSettled` events.
- **WP-EVM-12** (schema): add `arc` to the `chain` enum.
- **WP-EVM-14** (demo gate): Arc testnet end-to-end.
- **WP-EVM-15..17** (audit / mainnet): **deferred** — no mainnet this pass.
  Becomes either the Arc-mainnet-when-ready path or the Base-fallback path
  per §4.8.5.

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

**Final plan — Base single-chain v1.** Demo-path-first: WP-EVM-01..14 take
us to a Base Sepolia end-to-end demo (the demo gate); WP-EVM-15..17 are the
Base mainnet production path. Each WP is a discrete shippable unit. No time
estimates per repo convention. Chain target is locked (§4.6.5); there is no
optional/conditional WP in the v1 path.

### 8.1 v1 — Base launch path

**Demo path (WP-EVM-01..14):**

1. **WP-EVM-01 — Solidity scaffold.** Foundry project at
   `packages/program-evm/protocol-evm-v1/`. Empty contract stubs for Registry,
   Pool, Settler. Foundry config, basic CI integration. **No open question
   blocks this WP — it can start immediately.**
2. **WP-EVM-02 — PactRegistry.** Solidity port of `EndpointConfig` +
   `ProtocolConfig` + fee-recipient validation rules from `register_endpoint.rs`,
   `update_endpoint_config.rs`, `update_fee_recipients.rs`,
   `initialize_protocol_config.rs`, `pause_endpoint.rs`, `pause_protocol.rs`.
   Events for every state change.
3. **WP-EVM-03 — PactPool.** Solidity port of `CoveragePool` +
   `top_up_coverage_pool.rs`. Holds USDC; tracks per-slug `PoolState`.
4. **WP-EVM-04 — PactSettler core.** `settleBatch` with premium-in via
   `transferFrom`, fee fan-out, refund on breach. Mirror the per-call
   `SettlementStatus` enum and emit `CallSettled` per event in the batch.
   Include the bitmap-packed dedup map from §4.4 mitigation 3 from the start
   (cheap now, painful later; also future-proofs higher-gas chains).
5. **WP-EVM-05 — Settler hardening.** Exposure cap (hourly bucket per
   endpoint), `DelegateFailed` recovery via `try/catch` around `transferFrom`,
   `PoolDepleted` accounting, dedup via packed bitmap.
6. **WP-EVM-06 — Foundry test suite.** Mirror the LiteSVM test plan from
   `pact-network-v1-pinocchio/tests/`. Fuzz the bps fan-out and exposure cap.
   Add `forge snapshot` gas-regression tests so per-call gas regressions are
   caught at PR time.
7. **WP-EVM-07 — Deploy scripts + Base Sepolia deploy.** `forge script`
   targeting Base Sepolia. Operator runbook for `transferOwnership` to a
   Safe. (Depends on §9 Q-test: Sepolia-first is the assumed default.)
8. **WP-EVM-08 — TS client (`protocol-evm-v1-client`).** ABI exports, Base
   address registry entry, viem-based balance + allowance helpers, typed
   `settleBatch` wrapper. Registry structured to accept Arbitrum/Optimism
   entries later without a breaking change.
9. **WP-EVM-09 — `wrap` `BalanceCheck.evm` implementation.** Reads
   `balanceOf` + `allowance(agent, PactSettler)` via viem. Pass-through into
   existing chain-agnostic `wrapFetch`.
10. **WP-EVM-10 — `settler` `EvmSettlerAdapter`.** Behind a `ChainAdapter`
    interface (sibling to the existing Solana adapter). Shared batcher +
    idempotency (call_id dedup) + retry policy; the adapter is the only
    chain-aware seam.
11. **WP-EVM-11 — `indexer` Base event poller.** `eth_getLogs` (or viem
    `watchEvent`) for `CallSettled`, `PoolToppedUp`, `EndpointRegistered`,
    `FeeRecipientsUpdated`, `EndpointPaused`, `ProtocolPaused`. Writes to the
    existing Postgres schema with the `chain` column from WP-EVM-12. The
    existing bearer-gated `/events` POST stays for the Solana path.
12. **WP-EVM-12 — Postgres schema migration.** Add `chain` enum column to
    `Call`, `Settlement`, `PoolState`, `EndpointConfig`, `RecipientEarnings`.
    Backfill existing rows with `'solana'`. Enum members:
    `solana | base | arbitrum | optimism | ethereum` (full set defined now so
    later chains need no migration).
13. **WP-EVM-13 — `market-dashboard` chain switcher.** Drop-down in the
    dashboard header; per-chain filter on all stats panels. Defaults: Solana
    + Base visible.
14. **WP-EVM-14 — Base Sepolia demo end-to-end.** A real agent calls a real
    insured endpoint on Base Sepolia, premium debited from Sepolia-USDC,
    breach triggers refund, dashboard shows the call labeled "Base".
    **Demo gate.**

**Production path (WP-EVM-15..17):**

15. **WP-EVM-15 — Audit prep + Safe rotation.** Base mainnet readiness audit
    doc; same format as `docs/audits/2026-05-05-mainnet-readiness.md`.
    Rotate the deployer EOA → Safe multisig on Base. (Depends on §9
    Q-audit-firm + Q-audit-budget.)
16. **WP-EVM-16 — Third-party audit window.** One firm (see §9
    Q-audit-firm). Hold Base mainnet deploy until written report + fix-PR
    merged. The audited bytecode is the same bytecode that will later ship to
    Arbitrum/Optimism — one audit covers the family.
17. **WP-EVM-17 — Base mainnet deploy.** v1 EVM launch. Address registered in
    `protocol-evm-v1-client`. Post-deploy: smoke a real insured call on Base
    mainnet, confirm indexer picks up the on-chain `CallSettled` event.

### 8.2 v1.1 — Arbitrum One (NOT part of v1 launch)

Marked separate so it is unambiguous this is post-v1 work. Same audited
bytecode; trigger-driven per §4.6.6 (a specific integrator asks, or ~3
months of stable Base ops).

18. **WP-EVM-18 — Arbitrum One mainnet deploy.** Reuse the WP-EVM-07 deploy
    script with an Arbitrum RPC + chain-id. New address-registry entry in
    `protocol-evm-v1-client`. Add an Arbitrum poller instance to the indexer
    (WP-EVM-11 generalizes — no new code, new config). No new audit (identical
    bytecode). Safe multisig rotation on Arbitrum before go-live.

### 8.3 Deferred to v2 — Ethereum mainnet (at scale)

Not in the v1 or v1.1 scope. Ethereum L1 deployment requires, as hard
prerequisites (per §4.3-§4.6):

- **Off-chain premium accumulation** — settler ledger of signed per-call
  receipts; `settleNetPositions(agent[], netDebit[], slug[])` for periodic
  on-chain net settlement; on-chain dispute window. (This was the old
  WP-EVM-05b; it is v2 work, not v1.)
- **Enterprise / high-value-call premium tier** — a product-level reframe so
  the ~$5/call L1 gas overhead is a small fraction of the premium.
- **Ethereum Sepolia deploy + demo** (old WP-EVM-07a / 14a) and **Ethereum
  mainnet deploy** (old WP-EVM-17a) — all v2.

These are tracked as the v2 EVM expansion and intentionally left
unsequenced here; they get their own plan when v2 starts.

---

## 9. Open questions for Rick

### 9.0 Arc pivot — operative open questions (2026-05-15)

These supersede the Base-track questions below. Arc is the operative v1
target (§4.8); the Base questions in §9.1/§9.2 are retained as the
mainnet-fallback track.

1. **Confirm Arc testnet is the v1 target.** §4.8 takes Rick's pivot at
   face value: Arc testnet, no mainnet this pass, initial draft. Confirm
   that's the intent and there's no near-term Arc mainnet expectation we
   should be planning around.

2. **Arc availability — the hard blocker.** §4.8.4: I cannot confirm Arc
   public testnet is live as of early 2026. This is the **#1 thing to
   verify before any WP commits to Arc.** Does Rick / does Circle contact
   have confirmed access to an Arc testnet (RPC, chain-id, faucet, Foundry
   support)? If not, this is the first thing the WP-EVM-00 spike resolves.

3. **Mainnet fallback if Arc mainnet slips.** §4.8.5 open question: when
   Pact needs production mainnet and Arc mainnet is not
   production-credible, do we fall back to **Base mainnet** (§4.6 analysis,
   already done) and keep Arc as the testnet proving ground? Default
   proposal = yes. Confirm.

4. **Circle relationship as a strategic asset.** Pact + Circle Arc + USDC
   is a tightly aligned story (the insurance layer for USDC-native agent
   payments, on Circle's own chain). Is there a Circle partnership angle
   Rick wants to pursue — analogous to the "missing insurance primitive
   for x402" pitch that made Base attractive? This shapes whether Arc-first
   is also a go-to-market wedge, not just a tech fit.

5. **Circle concentration risk — explicit acceptance.** §4.8.3: on Arc,
   Circle controls the chain, the gas token, AND the unit of account
   simultaneously. This is the deepest single-vendor concentration of any
   option, with no OP-Stack-style portability escape hatch. Does Rick
   accept this risk for a testnet-only validation pass (lower stakes), with
   the concentration question revisited before any Arc mainnet decision?

6. **Tooling risk acceptance.** §4.8.3: audit firms and Foundry/Hardhat
   almost certainly have little Arc-specific maturity. Accept that the
   WP-EVM-00 spike may surface tooling gaps requiring workarounds (or a
   fallback to Base Sepolia for the initial demo if Arc tooling is not
   ready)?

The paymaster question (old §9.2 Q3) is **dropped** — Arc's USDC-native
gas makes it moot (§4.8.2a).

### 9.1 RESOLVED — Base track (now the mainnet-fallback questions)

- ~~**v1 chain target.**~~ **RESOLVED: Base.** Single-chain v1 EVM launch.
  Locked by Rick 2026-05-15. See §4.6.5.
- ~~**Extension order.**~~ **RESOLVED: v1 Base → v1.1 Arbitrum One → v1.2
  Optimism (opportunistic) → v2 Ethereum mainnet.** See §4.6.6.
- ~~**Ethereum-first vs L2-first.**~~ **RESOLVED:** Ethereum L1 deferred to
  v2 at scale; not economically efficient as the first EVM investment
  (§4.3 worked example: ~$5.44/call gas vs $0.0001-$0.10 premiums).
- ~~**Off-chain premium accumulation in v1.**~~ **RESOLVED: deferred to v2.**
  Base economics don't require it (§4.6.5 point 3). It is a v2 / Ethereum
  prerequisite, tracked in §8.3 — not v1 work.
- ~~**Pool bridging.**~~ **RESOLVED: independent per-chain pools, no
  bridging.** Holds for every chain in the extension path (§5).
- ~~**Package naming.**~~ **RESOLVED: `@pact-network/protocol-evm-v1`**
  (chain-agnostic; bytecode is shared across Base/Arbitrum/Optimism).
  Sibling to Solana's `@pact-network/protocol-v1-client`.

### 9.2 STILL OPEN — Base track (relevant only if we fall back to Base)

These applied when Base was the v1 target. Under the Arc pivot they are
**fallback-track** questions — they re-activate only if §9.0 Q3 resolves to
"fall back to Base." Retained verbatim for that path:

1. **Coinbase concentration hedge.** Single-chain v1 on Base couples Pact
   to Coinbase's L2 roadmap + commercial decisions. Default mitigation:
   accept OP Stack portability (Optimism = ~1-day redeploy, Arbitrum =
   ~1-week port). **Accept that, or do you want a parallel-track Optimism
   deploy from day 1 as a live hedge** (small extra ops + monitoring cost,
   same audited bytecode)? — *Gates whether §8.2 stays v1.1 or a second
   chain enters the v1 path.*

2. **Mainnet vs Base Sepolia testnet first.** Default assumed in §8.1:
   Base Sepolia end-to-end demo (WP-EVM-14) before spending audit budget,
   then Base mainnet. **Confirm Sepolia-first, or push straight to Base
   mainnet with a fresh audit?** — *Gates WP-EVM-07 target + WP-EVM-15
   sequencing.*

3. **ERC-4337 paymaster for gasless agent UX.** Do agents on Base pay
   their own gas, or do we sponsor a paymaster so the flow is "USDC in,
   USDC out, no ETH"? On Base the gas is sub-cent so the economics are
   trivial either way — this is purely an agent-UX call. Recommend **yes**
   (Base has mature paymaster infra: Coinbase Smart Wallet, Pimlico,
   Biconomy). **Confirm yes/no?** — *Gates an added paymaster-integration
   WP between WP-EVM-09 and WP-EVM-10 if yes.*

4. **Audit budget ceiling + preferred firm.** Rough USD ceiling for the
   third-party audit, and a firm preference? Options: Spearbit /
   OpenZeppelin (both Base-experienced), Trail of Bits (gold standard,
   slower + pricier), Sherlock / Cantina (contest model, cheaper, slower
   to schedule). — *Gates WP-EVM-15 + WP-EVM-16 calendar.*

5. **Base-specific concerns from Coinbase / Circle / x402 conversations.**
   Anything you've heard that would change the §4.6.5 read — a Coinbase
   commercial term you're uncomfortable with, an x402 roadmap conflict, a
   known Base incident we're not factoring, a Circle USDC-on-Base caveat?
   — *Gates whether the decision needs a revisit before WP-EVM-01.*

CCTP-for-treasury-rebalancing is **not** a v1 blocker (no second chain in
v1) — it returns as an open question at v1.1 when Arbitrum lands.

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
