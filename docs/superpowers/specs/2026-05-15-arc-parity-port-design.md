# Arc EVM Parity Port — Design Spec

**Date:** 2026-05-15
**Branch:** `feat/arc-protocol-v1`
**Status:** Design approved (brainstorming) — pending spec review → writing-plans
**Related:** PR #201 (EVM expansion design doc), PR #204 (WP-EVM-01 scaffold)

## 1. Goal

Port the Solana on-chain program `pact-network-v1-pinocchio` to Circle Arc
(EVM L1, testnet target) at **full behavioral parity**. The Solana program
plus its 10 LiteSVM test files are the authoritative behavioral spec. This is
a port, not a redesign — the protocol feature set is fixed.

Approach (decided in brainstorming): **behavioral port, EVM-idiomatic
mechanism.** Every Solana feature is reproduced and all economic math is
bit-identical; where Solana's mechanism was a platform workaround, the Arc
version takes the better EVM-idiomatic path and the divergence is logged with
pro/con (§4).

Non-goals: mainnet deploy (testnet only per Rick), off-chain accumulation
(v2), changing protocol economics, the Base fallback track.

## 2. Source of truth

| Artifact | Role |
|---|---|
| `packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/` | Behavioral spec (instruction handlers, `state.rs`, `fee.rs`, `constants.rs`, `error.rs`) |
| `…/pact-network-v1-pinocchio/tests/*.test.ts` (10 LiteSVM files) | Parity oracle — every scenario/assertion ported to Foundry |
| PR #201 `docs/evm/2026-05-15-evm-expansion-design.md` §2,§3 | Primitive mapping + contract shapes (architecture already settled) |
| `packages/program-evm/protocol-evm-v1/` (PR #204) | WP-EVM-01 scaffold this builds on |

## 3. Parity invariants — MUST match Solana exactly

Any deviation here is a parity bug, not an optimization.

- **Constants** (`constants.rs`): `MAX_BATCH_SIZE = 50`,
  `MIN_PREMIUM_LAMPORTS = 100` (→ `PremiumTooSmall`),
  `MAX_FEE_RECIPIENTS = 8`, `ABSOLUTE_FEE_BPS_CAP = 10_000`,
  `DEFAULT_MAX_TOTAL_FEE_BPS = 3_000`.
- **Fee fan-out math:** each recipient receives `premium * bps / 10_000`
  using integer floor division with the same truncation as Rust `u64`. The
  pool retains the residual. No rounding drift permitted.
- **Fee-recipient validation** (`fee.rs`): exactly one Treasury entry;
  Treasury `bps > 0`; per-entry `bps ≤ ABSOLUTE_FEE_BPS_CAP`;
  `sum_bps ≤ max_total_fee_bps`; no duplicate destinations including the
  post-substitution check (an Affiliate aliasing the Treasury destination
  must still be rejected); `fee_recipient_count` consistency.
- **Refund clamps + per-event status:** on breach, refund flows pool→agent,
  clamped first by pool balance (`PoolDepleted`) then by the hourly exposure
  cap (`ExposureCapClamped`). `SettlementStatus { Settled=0, DelegateFailed=1,
  PoolDepleted=2, ExposureCapClamped=3 }` with identical semantics; emitted
  per call.
- **Exposure cap:** per-endpoint rolling 1-hour window
  (`current_period_start` / `current_period_refunds`), reset logic identical
  to `settle_batch.rs`.
- **Dedup:** repeated `call_id` → `DuplicateCallId` revert (Solana rejects via
  non-empty CallRecord PDA; EVM via `mapping(bytes16 => bool)`).
- **Kill switches:** protocol `paused` → `settleBatch` reverts
  `ProtocolPaused` *before any per-event work or transfer*; endpoint `paused`
  enforced per event.
- **Guards:** `timestamp > now` → `InvalidTimestamp`;
  `fee_count_hint != stored count` → revert (kept as a parity guard even
  though Solidity calldata is typed — protects indexer assumptions).
- **Stats accounting:** `total_calls / total_breaches / total_premiums /
  total_refunds` and pool `totalDeposits / totalPremiums / totalRefunds /
  currentBalance` updated with identical arithmetic and ordering.
- **Error semantics:** every `PactError` variant (6000–6032, listed in
  `error.rs`) maps to a named Solidity custom error triggered by the same
  condition. Numeric codes do not carry over; names and trigger conditions
  do. Variants: `InsufficientBalance, EndpointPaused, ExposureCapExceeded,
  UnauthorizedSettler, UnauthorizedAuthority, DuplicateCallId,
  EndpointNotFound, PoolDepleted, InvalidTimestamp, BatchTooLarge,
  PremiumTooSmall, InvalidSlug, ArithmeticOverflow, FeeRecipientArrayTooLong,
  FeeBpsExceedsCap, FeeBpsSumOver10k, FeeRecipientDuplicateDestination,
  FeeRecipientInvalidUsdcMint, MultipleTreasuryRecipients,
  RecipientCoverageMismatch, ProtocolConfigNotInitialized,
  TreasuryNotInitialized, EndpointAlreadyRegistered, InvalidFeeRecipientKind,
  InvalidProtocolConfig, InvalidTreasury, MissingTreasuryEntry,
  TreasuryBpsZero, InvalidAffiliateAta, ProtocolPaused` (30 variants —
  `error.rs`/`PactErrors.sol` is the named authority; `FeeBpsSumOver10k`
  (6018) was omitted from the original list, corrected per WP-EVM-06 §(d)#1).
  (Some lose meaning on EVM — see §4 #7; tagged per-variant
  IDENTICAL/OPTIMIZED-DIVERGENCE/N-A-ON-EVM in the parity matrix
  `docs/superpowers/specs/2026-05-18-arc-parity-matrix.md`, WP-EVM-06.)

## 4. Divergence ledger — mechanism changes, behavior preserved

| # | Solana | Arc/EVM choice | Pro / Con |
|---|--------|----------------|-----------|
| 1 | SPL `Approve` → `SettlementAuthority` PDA delegate; program `invoke_signed` | ERC-20 `approve(PactSettler, N)` + `transferFrom`; `DelegateFailed` = try/catch around `transferFrom` | Pro: atomic, clean failure capture. Con: none material |
| 2 | Per-endpoint PDAs (`coverage_pool`, `endpoint`, `call`) | Single contracts with `mapping(bytes16 slug => …)` | Pro: O(1) reads, one allowance covers all endpoints, cheaper, simpler indexer. Con: no per-endpoint address isolation (unused in v1) |
| 3 | No on-chain events | First-class `event` on every state transition | Pro: indexer sources truth from chain. Con: marginal gas |
| 4 | Bytemuck structs with explicit padding | Solidity-native slot packing; value fields stay `uint64` | Pro: less storage gas, parity-friendly widths. Con: byte-layout not comparable to Solana (irrelevant — no shared state) |
| 5 | `SettlementAuthority` PDA-as-token-delegate | OZ `AccessControl` `SETTLER_ROLE`; the contract is itself the ERC-20 spender | Pro: single-tx revoke, audit-familiar. Con: none |
| 6 | `initialize_treasury`, `initialize_settlement_authority`, `initialize_protocol_config` (rent-funded accounts) | No rent on EVM → collapse into `PactRegistry` constructor/initializer + setters | Pro: 3 fewer instructions, smaller surface. Con: none |
| 7 | `AffiliateAta` SPL token-account introspection (owner == token program, state byte == initialized, mint == USDC); `AffiliatePda` reserved | **No EVM equivalent.** An ERC-20 recipient is just an address. `AffiliateAta`/`AffiliatePda` collapse to "Affiliate = plain address". The `kind` enum is preserved on the wire and in events for indexer parity; validation reduces to "non-zero, not duplicate, not aliasing Treasury". **CORRECTED (WP-EVM-06 §(d)#2):** `InvalidAffiliateAta` is **OPTIMIZED-DIVERGENCE, NOT N-A** — the residual "affiliate destination non-zero" invariant keeps it reachable with a narrowed trigger (zero-address guard, `FeeValidation.sol` final loop). Only `FeeRecipientInvalidUsdcMint` is genuinely **N-A-ON-EVM** (the `mint == USDC` SPL-platform check has no EVM meaning). Per-variant tags in the parity matrix `2026-05-18-arc-parity-matrix.md`. | Pro: correct for EVM (any address receives ERC-20); removes Solana-platform-specific logic. Con: drops checks that have no EVM meaning — **this is the single largest intentional divergence; called out explicitly** |
| 8 | USDC = SPL mint; "lamports" naming | USDC = Arc native gas token *and* 6-dec ERC-20; `uint64` amounts retained; **paymaster WP dropped** | Pro: dual-token problem gone. Con: none |
| 9 | `update_endpoint_config` per-field presence flags (optional-arg mutation) | Full typed field set — callers pass current values for unchanged fields (handoff §(b) ruling 7) | Pro: simpler typed calldata; state parity preserved (same resulting `EndpointConfig`). Con: none — mechanism-only divergence (WP-EVM-06 §(d)#3) |
| 10 | `CoveragePool.created_at` set at `register_endpoint` | Set lazily at first `topUp` on EVM; informational-only, never read by `top_up`/`settle` logic (handoff §(b) ruling D2) | Pro: no register-time pool write needed (§4 #2 mapping). Con: `created_at` semantics differ pre-first-topUp — informational-only, no economic effect (WP-EVM-06 §(d)#4) |

## 5. Package structure (mirrors the Solana side)

Two packages, exactly paralleling `protocol-v1-client` (Solana):

1. **`@pact-network/protocol-evm-v1`** — Foundry/Solidity contracts at
   `packages/program-evm/protocol-evm-v1/` (scaffolded in WP-EVM-01). Not a
   pnpm workspace member (forge-built, like the Pinocchio program; outside
   the `packages/*` glob). Emits ABI + bytecode artifacts.

2. **`@pact-network/protocol-evm-v1-client`** — NEW TypeScript package at
   `packages/protocol-evm-v1-client/`, a pnpm workspace member, sibling to
   `packages/protocol-v1-client/`. Required for parity at the integration
   layer: the Solana client is consumed by `cli`, `indexer`
   (`on-chain-sync`, `ops`), and `settler` — parity that stops at the
   contract is not parity. Module mapping:

   | Solana `protocol-v1-client` | EVM `protocol-evm-v1-client` |
   |---|---|
   | `pda.ts` | `addresses.ts` (deployed addresses per chain — no PDAs) |
   | `instructions.ts` | `encode.ts` (viem calldata builders) |
   | `state.ts` | `state.ts` (view-call + event decoders) |
   | `errors.ts` | `errors.ts` (custom-error selector → name) |
   | `constants.ts` | `constants.ts` (Arc chain id, ABI re-export) |
   | `helpers.ts` | `helpers.ts` |

   **This corrects PR #201 design doc §7.1**, which hedged "client probably
   not needed for v1." That predated the commitment to full behavioral
   parity including the integration layer. The client is required; the
   settler `ChainAdapter` and indexer per-chain poller (design §6.2) import
   it.

## 6. Contract module structure

`packages/program-evm/protocol-evm-v1/src/` (builds on the WP-EVM-01 scaffold):

- `ArcConfig.sol` — port `constants.rs`
- `errors/PactErrors.sol` — custom errors mirroring every `PactError` variant
- `libraries/FeeValidation.sol` — port `fee.rs` (`parse_and_validate`,
  post-substitution checks, EVM-adapted affiliate validation per §4 #7)
- `PactRegistry.sol` — endpoint registry, protocol config, treasury address,
  fee policy, kill switches (absorbs the 3 Solana `initialize_*` instructions)
- `PactPool.sol` — per-slug `PoolState`, `topUp`, `balanceOf`, USDC custody,
  settler-gated debit/credit/refund internals
- `PactSettler.sol` — `settleBatch`, `SETTLER_ROLE`, per-event loop
  (validate → dedup → premium-in → fee fan-out → refund w/ clamps → status →
  events → stats)

## 7. Test oracle

Port all 10 LiteSVM files to a forge-std Foundry suite, scenario-for-scenario:
`00-protocol-config`, `00-treasury`, `01-pool`, `02-endpoint`,
`05-settle-batch`, `06-pause`, `07-exposure-cap`, `09-auth-pda` (→ role
model), `10-pause-protocol` (helpers ported as Foundry test utils). Every
Solana assertion — exact balances, fee-split amounts, refund amounts, revert
reasons — reproduced as a Foundry assertion. Additional: fuzz tests for
fee-split integer rounding and batch handling; the live USDC `decimals()==6`
assertion deferred from WP-EVM-01. **The ported suite passing is the parity
proof.**

## 8. Execution — wave-based work packages

One crew per WP, on `feat/arc-protocol-v1`, atomic conventional commits.
WP-04/05 use GSD (complex). WP-02→05 are sequential (each builds on prior
contract state); WP-06 client can begin once ABIs stabilize after WP-04.

- **WP-EVM-02** — errors + events + `ArcConfig` + `PactRegistry` +
  `FeeValidation` library + ported registry/treasury/protocol-config tests
- **WP-EVM-03** — `PactPool` full logic + ported pool tests
- **WP-EVM-04** — `PactSettler` happy path (premium-in, fee fan-out, refund,
  events, stats) + ported settle-batch tests *(GSD)*
- **WP-EVM-05** — settler hardening: exposure cap, pool-depleted, kill
  switches, batch limits, status codes + ported pause/exposure tests *(GSD)*
- **WP-EVM-06** — `@pact-network/protocol-evm-v1-client` package +
  consolidated fuzz/gas suite + parity-matrix doc (per-variant
  IDENTICAL / OPTIMIZED-DIVERGENCE / N-A-on-EVM)
- **WP-EVM-07** — deploy script + Arc testnet deploy + arcscan verify
  *(deferred, separate cycle; not part of this parity effort)*

## 9. Success criteria

- All 6 contracts/libraries implemented; `forge build` green.
- Ported Foundry suite (all 10 LiteSVM scenarios) passes; economic outcomes
  bit-identical to Solana for every IDENTICAL-marked behavior.
- `@pact-network/protocol-evm-v1-client` builds and exposes encode/decode/
  error/address surface paralleling `protocol-v1-client`.
- Parity matrix doc complete: every Solana behavior marked IDENTICAL,
  OPTIMIZED-DIVERGENCE (with §4 reference), or N/A-on-EVM (with rationale).
- No mainnet deploy. Testnet deploy is WP-EVM-07, out of scope here.

---

## WP-EVM-06 Corrections (formal §(d) closed-list reconciliation)

This appendix records every spec correction WP-EVM-06 applied so a reviewer
can verify the spec now matches implemented reality. The handoff §(d)
consolidated list (items 1-8) is COMPLETE and CLOSED. Git history preserves
the before-state; the per-variant authority is the parity matrix
`docs/superpowers/specs/2026-05-18-arc-parity-matrix.md`.

1. **§3 omitted `FeeBpsSumOver10k` (6018).** WHAT: added it to the §3
   enumerated `PactError` list (29 → 30) and annotated the count + authority.
   WHY: `error.rs`/`PactErrors.sol` define 30 variants; 6018 is a DISTINCT
   trigger from `FeeBpsExceedsCap` (6017) — `fee.rs:83-88` returns
   `FeeBpsSumOver10k` when `sum_bps > ABSOLUTE_FEE_BPS_CAP`. The original
   list was a documentation defect; the code was always correct (handoff
   §(b) ruling 1). Matrix A#16 IDENTICAL.
2. **§4 #7 wrongly called `InvalidAffiliateAta` unreachable/N-A.** WHAT:
   rewrote the §4 #7 cell — `InvalidAffiliateAta` is OPTIMIZED-DIVERGENCE
   (reachable via the zero-address affiliate guard); only
   `FeeRecipientInvalidUsdcMint` is true N-A-ON-EVM. WHY: the residual
   "affiliate destination non-zero" invariant survives the §4 divergence
   (handoff §(b) ruling 2). Matrix A#29 / A#18.
3. **`updateEndpointConfig` mechanism divergence.** WHAT: added §4 row 9 —
   Solana per-field presence flags → EVM full typed field set. WHY: state
   parity is preserved (same resulting `EndpointConfig`); only the calldata
   mechanism differs (handoff §(b) ruling 7). Matrix B "Stats accounting".
4. **D2 `created_at` timing.** WHAT: added §4 row 10 — EVM sets
   `CoveragePool.created_at` lazily at first `topUp` (Solana sets at
   register). WHY: informational-only; never read by `top_up`/`settle`
   logic, no economic effect (handoff §(b) ruling D2).
5. **LOCKED ruling #8 (D1-scope refinement).** WHAT: recorded here — WP-03
   D1 ("NO modification of committed WP-02 `PactRegistry`") was scoped to
   `PactPool` reaching into the registry; it does NOT bar WP-04+ adding
   their own `SETTLER_ROLE`-gated writers where §6 places `EndpointConfig`
   state. WHY: WP-04 E1 added `recordCallAndCapAccrual`/`recordRefundPaid`
   under this (now-locked) refinement; it is a refinement, not a
   contradiction. Matrix B "Stats accounting".
6. **P3 OPTIMIZED-DIVERGENCE corner.** WHAT: recorded the §4 #5 corner —
   unauthorized-caller-AND-paused returns `AccessControlUnauthorizedAccount`
   on EVM vs `ProtocolPaused` on Solana. WHY: Solidity modifiers run before
   the body; authorized-settler+paused is IDENTICAL (`ProtocolPaused`); the
   corner is operationally meaningless (captain-ratified WP-05 GATE-A P3).
   Matrix Section C P3.
7. **N-A-ON-EVM rows.** WHAT: cross-linked the seven `05-NA-MATRIX` rows
   (09:47/78, 09:144, 09:172, 10:94/128, D-LOCK-EXPCAP-NA). WHY: PDA/Treasury
   spoofing is impossible on EVM; the residual authority invariant is
   source-enforced and covered by the surviving WP-02 tests (all PASS).
   Matrix Section C.
8. **WP-02/03/04 N-A items.** WHAT: cross-linked the Solana-platform-mechanics
   N-A class — true-N-A `FeeRecipientInvalidUsdcMint`; WP-04 E4 `CallRecord`
   byte-layout → `vm.expectEmit` on `CallSettled`; PDA/`InvalidSeeds`,
   `AccountAlreadyInitialized`, signer/rent/`system_program`, byte-offset,
   SPL-mint constants. WHY: genuine Solana-platform mechanics with no EVM
   trigger (handoff §(c) PORT-vs-N-A rule). Matrix Section E.

This also corrects PR #201 design doc §7.1 ("client probably not needed for
v1"): the `@pact-network/protocol-evm-v1-client` IS required for parity at
the integration layer (settler `ChainAdapter` + indexer per-chain poller) —
delivered in WP-EVM-06 (design spec §5).
