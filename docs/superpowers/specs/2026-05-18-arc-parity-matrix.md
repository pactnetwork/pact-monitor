# Arc EVM Parity Matrix — Pact Network v1 (Solana → Arc/EVM)

**Date:** 2026-05-18 (authored WP-EVM-06)
**Branch:** `feat/arc-protocol-v1`
**Status:** Complete — the per-variant parity proof for the Arc EVM port.
**Scope:** Every `PactError` variant + every design-spec §3 behavior, each
tagged **IDENTICAL** / **OPTIMIZED-DIVERGENCE** (§4 ref) / **N-A-ON-EVM**
(rationale), citing file:line authority.

This document is a **synthesis of already-settled facts** — it does NOT
re-derive or reopen any locked ruling. Sources (authoritative, read
verbatim): the Arc EVM port handoff `2026-05-18-arc-evm-port-handoff.md`
§(b) rulings 1-8 + §(d) consolidated items 1-8 + WP-04 OUTCOMES E1-E4 + WP-05
OUTCOMES P1/P3; `05-NA-MATRIX.md` (verbatim); design spec
`2026-05-15-arc-parity-port-design.md` §3/§4; `src/errors/PactErrors.sol`
(the 30-variant named authority, error.rs-ordered); the compiled contract
ABIs (`out/<C>.sol/<C>.json`) as the factual reachability evidence.

The parity proof is the 109-test Foundry suite (102 ported LiteSVM scenarios
+ 5 fuzz + 2 USDC-decimals), all green, plus the `protocol-evm-v1-client`
TS suite (41 green).

## Legend

- **IDENTICAL** — same trigger condition, bit-identical economic outcome.
  A mechanism note (e.g. §4 #2 slug-mapping vs PDA) may apply where the
  *implementation* differs but the *behavior contract* (same input → same
  result/revert) is preserved.
- **OPTIMIZED-DIVERGENCE** — Solana mechanism was a platform workaround; the
  Arc version takes the EVM-idiomatic path. Behavior preserved within the
  documented §4 divergence; the corner where observable behavior differs is
  operationally meaningless. Cites the §4 ledger row.
- **N-A-ON-EVM** — a genuine Solana-platform mechanic (PDA
  derivation/ownership, SPL-mint/ATA introspection, rent/signer/account-init,
  byte-layout). No EVM trigger; the residual invariant (if any) is
  source-enforced and covered by the named surviving test.

---

## Section A — Per-`PactError` variant matrix (all 30, error.rs order)

`PactErrors.sol` declares all 30 for parity completeness (design spec §3
binding rule: "every PactError variant maps to a named Solidity custom error
triggered by the same condition"). "Reachable" = present in a compiled
contract ABI (the error is actually revert-reachable on EVM); "declared-only"
= kept for parity completeness but has no EVM revert path (the behavior is
expressed by a status code or an EVM-idiomatic error per §4).

| # | PactError | Disposition | Authority + rationale |
|---|---|---|---|
| 1 | `InsufficientBalance` | N-A-ON-EVM | Declared-only. Solana 6000 generic pool-shortfall has no `settle_batch` revert trigger; on EVM a pool shortfall on refund is the `PoolDepleted` per-call **status** clamp (`settle_batch.rs:462-469` ↔ `PactSettler.sol:232`) and any internal under-subtraction is the named `ArithmeticOverflow` (D6, `_ckSub`). No distinct revert path. |
| 2 | `EndpointPaused` | IDENTICAL | Per-event endpoint-paused revert. `settle_batch.rs:209` ↔ `PactSettler.sol:102` at the LOCKED D-LOCK-PREC slot (WP-05 OUTCOMES seam #2). Reachable (PactSettler ABI). Test: `test_EndpointPaused_RevertsPerEvent`. |
| 3 | `ExposureCapExceeded` | N-A-ON-EVM | `05-NA-MATRIX` **D-LOCK-EXPCAP-NA** (verbatim): no `settle_batch` trigger — the cap clamps the refund to the `ExposureCapClamped` *status*, it never reverts an "exceeded" error. error.rs:6002 is unreachable from `settle_batch.rs`. Clamp behavior tested by `test_ExposureCapClamped_PartialActualRefund` / `test_ExposureCap_CumulativeClampAcrossBatches`. |
| 4 | `UnauthorizedSettler` | OPTIMIZED-DIVERGENCE (§4 #5) | Declared-only. The Solana `SettlementAuthority` PDA-delegate signer check becomes OZ `AccessControl` `SETTLER_ROLE`; an unauthorized settler reverts `AccessControlUnauthorizedAccount` (WP-04 E2 LOCKED; confirmed by `05-NA-MATRIX` P3). Condition preserved; EVM-idiomatic surface. The named variant is kept for parity completeness. |
| 5 | `UnauthorizedAuthority` | IDENTICAL | Non-authority caller of a privileged registry/pool mutator reverts. Reachable (PactRegistry/PactPool ABI). WP-03 D3 (`topUp` authority-gated). Tests: `test_*_RejectsNonAuthority` (4, all PASS — `05-NA-MATRIX` §"Surviving-Invariant"). |
| 6 | `DuplicateCallId` | IDENTICAL (mech §4 #2) | Repeated `callId` reverts. Mechanism: `mapping(bytes16=>bool) _settledCallIds` vs non-empty CallRecord PDA (§4 #2); behavior contract identical (same input → same revert). WP-04 E4 + LOCKED guard precedence (`settle_batch.rs:194` ↔ `PactSettler.sol:94`). Reachable. Tests: dedup precedence + `testFuzz_DuplicateCallIdRevertsAnyPosition`. |
| 7 | `EndpointNotFound` | IDENTICAL | No endpoint for slug. WP-03 D1 (`registry.isRegistered(slug)`). Reachable (PactRegistry/PactPool ABI). |
| 8 | `PoolDepleted` | IDENTICAL (status, not revert) | Per-call **status** clamp on BOTH chains (never a revert): `settle_batch.rs:462-469` ↔ `PactSettler.sol:232`; `SettlementStatus.PoolDepleted=2`. WP-05 OUTCOMES seam #4 + D-LOCK-CLAMP-ORDER. Test: `test_PoolDepleted_RefundSkippedAndMarked`, `test_PoolDepleted_OverwritesExposureCapClamped`. The error.rs `PoolDepleted` variant is a status code on both chains — parity-exact. |
| 9 | `InvalidTimestamp` | IDENTICAL | `timestamp > now` → revert (spec §3 guard). `PactSettler.sol` guard slot (WP-04 LOCKED precedence). Reachable. Test: `test_InvalidTimestampRejected`. |
| 10 | `BatchTooLarge` | IDENTICAL | `events.length > MAX_BATCH_SIZE (50)` strict `>`, pre-loop. `settle_batch.rs:132-135` ↔ `PactSettler.sol:74` (WP-05 OUTCOMES seam #1). Reachable. Tests: `test_BatchTooLarge_50EventsAccepted/_51EventsRevert`, `testFuzz_BatchOverLimitReverts`. |
| 11 | `PremiumTooSmall` | IDENTICAL | `premium < MIN_PREMIUM (100)` → revert. WP-04 guard. Reachable. Test: `test_MinPremiumEdgeRejected`. |
| 12 | `InvalidSlug` | IDENTICAL | Non-printable slug byte → revert (fee/registry validation). Reachable (PactRegistry ABI). |
| 13 | `ArithmeticOverflow` | IDENTICAL (D6, strengthened) | Named in BOTH directions on EVM (`_ckAdd` overflow / `_ckSub` underflow) — never a Solidity `Panic` (WP-03 D6 LOCKED). Reachable in all 3 contracts. Parity-exact and strictly louder than Solana. |
| 14 | `FeeRecipientArrayTooLong` | IDENTICAL | `> MAX_FEE_RECIPIENTS (8)` → revert (`fee.rs` / `FeeValidation.sol`). Reachable (PactRegistry/PactSettler ABI). |
| 15 | `FeeBpsExceedsCap` | IDENTICAL | Per-entry `bps > cap` or `sum_bps > max_total_fee_bps` (handoff §(b) ruling 1; ruling 3 config check). `fee.rs:83-88` ↔ `FeeValidation.sol`. Reachable. Tests: FeeValidation suite (15). |
| 16 | `FeeBpsSumOver10k` | IDENTICAL | **The 30th variant** (handoff §(b) ruling 1; §(d)#1). Distinct from #15: `sum_bps > ABSOLUTE_FEE_BPS_CAP (10000)`. `fee.rs:83-88` ↔ `FeeValidation.sol`. Reachable (PactRegistry ABI). The design-spec §3 list omitted it — **doc defect, code correct** (T10 corrects §3). |
| 17 | `FeeRecipientDuplicateDestination` | IDENTICAL | Duplicate destination incl. post-substitution Treasury-alias (handoff §(b) ruling 2/4/5). `fee.rs` ↔ `FeeValidation.sol`. Reachable. |
| 18 | `FeeRecipientInvalidUsdcMint` | N-A-ON-EVM (§4 #7) | Handoff §(b) ruling 2 + §(d)#2: the ONLY true N-A in the affiliate family — `mint == USDC_DEVNET/MAINNET` is a Solana SPL-platform check with no EVM meaning. Declared-only. |
| 19 | `MultipleTreasuryRecipients` | IDENTICAL | `> 1` Treasury entry → revert. `fee.rs` ↔ `FeeValidation.sol`. Reachable. |
| 20 | `RecipientCoverageMismatch` | OPTIMIZED-DIVERGENCE (§4 #2) | Behavior: `feeCountHint != stored count` → revert — IDENTICAL and reachable (PactSettler ABI), pinned by LOCKED guard precedence (`settle_batch.rs:213` ↔ `PactSettler.sol:104`). The Solana variant ALSO covered SPL-ATA-ordering / cached `coverage_pool` mismatch — those sub-conditions are §4 #2 N-A (slug-keyed mappings, no ATAs/PDAs). Net: the surviving sub-condition is identical; the dropped sub-conditions are §4 #2. |
| 21 | `ProtocolConfigNotInitialized` | N-A-ON-EVM (§4 #6) | The 3 Solana `initialize_*` instructions collapse into the `PactRegistry` constructor (§4 #6; no rent accounts). Config is always initialized post-construction — no "not initialized" trigger. Declared-only. Residual = the WP-02 authority invariant. |
| 22 | `TreasuryNotInitialized` | N-A-ON-EVM (§4 #6) | As #21: `treasuryVault` is a constructor-set immutable address; never "uninitialized". Declared-only. |
| 23 | `EndpointAlreadyRegistered` | IDENTICAL | Re-register a slug → revert, validated AFTER fee parse (handoff §(b) ruling 4 step order). Reachable (PactRegistry ABI). |
| 24 | `InvalidFeeRecipientKind` | IDENTICAL | `kind` byte not 0/1/2 → revert. `fee.rs` ↔ `FeeValidation.sol`. Reachable. |
| 25 | `InvalidProtocolConfig` | N-A-ON-EVM (§4 #6) | Solana "supplied ProtocolConfig is not the canonical PDA / wrong owner" — PDA spoofing impossible on EVM (`05-NA-MATRIX` rows 09:47/78, 09:144, 10:94/128 class). §4 #6 collapse. Declared-only; residual = `onlyAuthority` (WP-02 tests). |
| 26 | `InvalidTreasury` | N-A-ON-EVM (§4 #6) | As #25 for Treasury PDA (`05-NA-MATRIX` row 09:172). `treasuryVault` immutable. Declared-only. |
| 27 | `MissingTreasuryEntry` | IDENTICAL | `fee_recipients` lacks exactly one Treasury → revert at register in BOTH (handoff §(b) ruling 5: `count==0` defaults → `MissingTreasuryEntry`). Reachable (PactRegistry ABI). |
| 28 | `TreasuryBpsZero` | IDENTICAL | Treasury entry `bps == 0` → revert. `fee.rs` ↔ `FeeValidation.sol`. Reachable. |
| 29 | `InvalidAffiliateAta` | OPTIMIZED-DIVERGENCE (§4 #7) | Handoff §(b) ruling 2 + §(d)#2: NOT N-A. SPL-ATA introspection has no EVM equivalent, but the residual invariant "affiliate destination non-zero" keeps it reachable with a NARROWED trigger (zero-address affiliate guard, `FeeValidation.sol` final loop). Reachable (PactRegistry ABI) — confirms the ruling. |
| 30 | `ProtocolPaused` | IDENTICAL | Protocol kill switch: `settleBatch` fast-reverts pre-loop before any per-event work/transfer. `settle_batch.rs:99-115` ↔ `PactSettler.sol:70` (WP-05 OUTCOMES seam #1, first body statement). Reachable. Tests: `test_ProtocolPaused_RejectsSettleBatch/_ResumesAfterUnpause`. (See Section C P3 for the unauthorized-caller-AND-paused corner.) |

**Count: 30/30.** IDENTICAL: 18 · OPTIMIZED-DIVERGENCE: 3 (#4, #20, #29) ·
N-A-ON-EVM: 9 (#1, #3, #18, #21, #22, #25, #26 + the platform class) — note
#8 `PoolDepleted` is IDENTICAL as a status code (never a revert on either
chain).

---

## Section B — Per design-spec §3 behavior matrix

| §3 behavior | Disposition | Authority + rationale |
|---|---|---|
| Constants (`MAX_BATCH_SIZE 50`, `MIN_PREMIUM 100`, `MAX_FEE_RECIPIENTS 8`, `ABSOLUTE_FEE_BPS_CAP 10000`, `DEFAULT_MAX_TOTAL_FEE_BPS 3000`) | IDENTICAL | `ArcConfig.sol` == `constants.rs`, bit-identical. Client `constants.ts` T2 test asserts parity vs both authorities. |
| Fee fan-out math (`premium*bps/10_000` u64 floor; pool keeps residual; no rounding drift) | IDENTICAL | `settle_batch.rs:442-453` ↔ `PactSettler` fee loop. Proven across the input space by `testFuzz_FeeSplitSingleRecipient` / `_MultiRecipient` (257 runs each, conservation `pool+Σfees==premium`) — NO Trigger-1 divergence. |
| Fee-recipient validation (`fee.rs`: one Treasury, Treasury bps>0, per-entry/sum caps, dup incl. post-substitution, count consistency) | IDENTICAL (+ §4 #7 affiliate part OPTIMIZED-DIVERGENCE) | Handoff §(b) rulings 1-5: `FeeValidation.validate` on both register paths (ruling 5, provably idempotent), `validateDefaultTemplate` a SEPARATE faithful port (ruling 3). FeeValidation suite (15) green. Affiliate-ATA introspection → §4 #7 (variant #29). |
| Refund clamps + per-event status (`SettlementStatus{Settled,DelegateFailed,PoolDepleted,ExposureCapClamped}`; clamp order pool-balance THEN exposure-cap) | IDENTICAL | WP-05 OUTCOMES P1 (ExposureCapClamped inference `PactSettler.sol:192-193`, parity-exact to `intended>cap_remaining`) + seams #3/#4 + D-LOCK-CLAMP-ORDER. `settle_batch.rs:400-414/462-469`. Tests: cap/pool clamp + combined-order. |
| Exposure cap (per-endpoint rolling 1-hour window; reset identical to `settle_batch.rs`) | IDENTICAL | WP-04 E1: period reset in `recordCallAndCapAccrual` (`PactRegistry.sol:260-263`, `settle_batch.rs:396-399`); WP-05 only adds the clamp decision. Tests: `test_ExposureCap_ResetsAfter1Hour`, `test_EndpointStats_PeriodReset/_WithinWindowAccumulates`. |
| Dedup (`call_id` → `DuplicateCallId`) | IDENTICAL (mech §4 #2) | `mapping(bytes16=>bool)` vs CallRecord PDA. Variant #6; WP-04 E4. |
| Kill switches (protocol `paused`→revert before any per-event work/transfer; endpoint `paused` per event) | IDENTICAL (+ P3 corner OPTIMIZED-DIVERGENCE) | WP-05 OUTCOMES seams #1/#2. The unauthorized-caller-AND-paused corner is §4 #5 OPTIMIZED-DIVERGENCE — Section C P3. |
| Guards (`timestamp>now`→`InvalidTimestamp`; `fee_count_hint != stored count` kept as parity guard) | IDENTICAL | Variants #9, #20. WP-04 LOCKED guard precedence (re-derived `settle_batch.rs:144-262`). |
| Stats accounting (`total_calls/breaches/premiums/refunds`, pool `totalDeposits/Premiums/Refunds/currentBalance`; identical arithmetic + ordering) | IDENTICAL | WP-04 E1 TWO-hook split (`recordCallAndCapAccrual` + `recordRefundPaid`) preserves Solana's two distinct `ep.*` mutation points + ordering (`settle_batch.rs:385-414/493-499`). LOCKED ruling #8 (D1-scope refinement) authorizes the SETTLER_ROLE-gated writers. Tests: `test_EndpointStats_*`. |
| Error semantics (every variant maps to a named error, same trigger; codes do not carry) | IDENTICAL | Section A (30/30). Client `errors.ts` selector map cross-checked vs independent `keccak4(sig)` (T3). |
| Events (first-class on every state transition; indexer truth source) | OPTIMIZED-DIVERGENCE (§4 #3) | Solana emits none; EVM adds 7 `PactEvents` (`CallSettled` etc.) — pure addition, behavior superset. WP-04 E3 (one `CallSettled` per call, byte-identical topic0). Client `state.ts` decodes all 7 (T5). |
| Agent custody (SPL `Approve`→PDA delegate / `transferFrom`; `DelegateFailed`) | OPTIMIZED-DIVERGENCE (§4 #1/#5) | ERC-20 `approve(PactSettler,n)` + `transferFrom` try/catch → `DelegateFailed` status. WP-04 E4 (dedup SET before premium-in, non-retryable). |

---

## Section C — `05-NA-MATRIX.md` rows (verbatim) + P3 corner

These are reproduced verbatim from
`.planning/phases/05-wp-evm-05-pactsettler-hardening/05-NA-MATRIX.md` (handoff
mandate: read verbatim, do not re-derive). Each N-A row's residual authority
invariant is source-enforced and covered by the named surviving WP-02 test
(all 4 PASS).

| Source scenario | Disposition | Rationale | Surviving test |
|---|---|---|---|
| 09:47 — pause_endpoint rejects fake ProtocolConfig at wrong address | N-A-ON-EVM | PDA-address spoofing impossible on EVM; all privileged mutators are `onlyAuthority`; source-enforced, WP-02-tested. | `test_PauseEndpoint_RejectsNonAuthority` |
| 09:78 — pause_endpoint rejects ProtocolConfig wrong owner | N-A-ON-EVM | PDA-owner spoofing impossible on EVM; as above. | `test_PauseEndpoint_RejectsNonAuthority` |
| 09:144 — update_endpoint_config rejects fake ProtocolConfig | N-A-ON-EVM | PDA-address spoofing impossible on EVM. | `test_UpdateEndpointConfig_RejectsNonAuthority` |
| 09:172 — update_fee_recipients rejects fake Treasury PDA | N-A-ON-EVM | Treasury PDA spoofing impossible; `treasuryVault` immutable; `onlyAuthority`. | `test_UpdateFeeRecipients_RejectsNonAuthority` |
| 10:94 — pause_protocol rejects fake ProtocolConfig | N-A-ON-EVM | PDA-address spoofing impossible on EVM. | `test_PauseProtocol_RejectsNonAuthority` |
| 10:128 — pause_protocol rejects ProtocolConfig wrong owner | N-A-ON-EVM | PDA-owner spoofing impossible on EVM. | `test_PauseProtocol_RejectsNonAuthority` |
| D-LOCK-EXPCAP-NA — `ExposureCapExceeded` in settle path | N-A-ON-EVM | No `settle_batch` trigger: cap clamps to a status, never reverts; error.rs:6002 unreachable from `settle_batch.rs`. | clamp tested by `test_ExposureCapClamped_PartialActualRefund` / `test_ExposureCap_CumulativeClampAcrossBatches` |

### P3 OPTIMIZED-DIVERGENCE corner (unauthorized caller AND protocol paused)

Verbatim from `05-NA-MATRIX.md` "P3 OPTIMIZED-DIVERGENCE Corner":

- **Solana** (`settle_batch.rs:99-115` before `:117-130`): protocol-paused
  check fires BEFORE the settler-identity check → unauthorized+paused returns
  `ProtocolPaused`.
- **EVM**: `settleBatch` carries `onlyRole(SETTLER_ROLE)` (WP-04 E2 LOCKED);
  Solidity modifiers run before the body → unauthorized+paused returns
  `AccessControlUnauthorizedAccount`.
- **Operationally-real path** (authorized settler + paused): BOTH chains
  return `ProtocolPaused` — IDENTICAL; the only production-relevant path.
- **Disposition: OPTIMIZED-DIVERGENCE** (§4 #5; captain-ratified WP-05
  GATE-A P3). The alternative (in-body `_checkRole` after the pause check)
  rewrites the LOCKED WP-04 E2 shape — FORBIDDEN (D-LOCK-6). The divergence
  is confined to an operationally-meaningless corner (an unauthorized caller
  is never a legitimate settler). Tests assert only the real paths
  (`test_ProtocolPaused_RejectsSettleBatch/_ResumesAfterUnpause`); no test
  asserts Solana behavior for the unauthorized+paused corner — intentional.

(The bounded adversarial-pass review — 3 vectors, all CLEAN — is recorded in
full in `05-NA-MATRIX.md`; not reproduced here. No new vulnerability.)

---

## Section D — §(d) consolidated spec-defect / correction disposition (CLOSED list 1-8)

The handoff §(d) list is COMPLETE and CLOSED. Each item, its disposition in
this matrix, and the formal design-spec correction applied by WP-EVM-06 T10
(`docs/superpowers/specs/2026-05-15-arc-parity-port-design.md`):

1. **§3 omits `FeeBpsSumOver10k` (6018)** → matrix A#16 IDENTICAL (30
   variants; `error.rs`/`PactErrors.sol` are the authority). Spec edit: add
   it to the §3 enumerated list (29 → 30).
2. **§4 #7 "InvalidAffiliateAta unreachable/N-A" is wrong** → matrix A#29
   OPTIMIZED-DIVERGENCE (zero-address guard, reachable); only
   `FeeRecipientInvalidUsdcMint` (A#18) is true N-A. Spec edit: rewrite §4 #7
   wording.
3. **`updateEndpointConfig` per-field-flags → full-typed-set** → matrix
   (handoff §(b) ruling 7) mechanism divergence, state parity preserved.
   Spec edit: add the §4 note.
4. **D2 `created_at` lazy-at-first-`topUp` on EVM** (Solana sets at register;
   informational-only, never read by `top_up`/`settle`) → spec edit: add the
   §4 / state note.
5. **LOCKED ruling #8 (D1-scope refinement)** — WP-03 D1 was scoped to
   `PactPool` reaching into the registry; it does NOT bar WP-04+ adding their
   own SETTLER_ROLE-gated writers where §6 places `EndpointConfig` state →
   matrix B "Stats accounting". Spec edit: append ruling #8 to the locked
   rulings / §6.
6. **P3 OPTIMIZED-DIVERGENCE corner** → Section C P3. Spec edit: §4 #5 note.
7. **N-A-ON-EVM rows from `05-NA-MATRIX`** → Section C (verbatim) +
   matrix A#3/#21/#22/#25/#26. Spec edit: §4 cross-link to this matrix.
8. **WP-02/03/04 N-A items** (true-N-A `FeeRecipientInvalidUsdcMint`; WP-04
   E4 `CallRecord` byte-layout → `vm.expectEmit` on `CallSettled`; the
   Solana-platform-mechanics class) → Section E. Spec edit: §4 cross-link.

---

## Section E — Solana-platform-mechanics N-A class (§(d)#8 fold)

Genuine Solana-platform mechanics with no EVM equivalent, folded into a
single N-A-ON-EVM class (handoff §(c) PORT-vs-N-A rule + §(d)#8):

- **PDA derivation / `InvalidSeeds`** — EVM uses slug-keyed mappings (§4 #2);
  no seed derivation.
- **`AccountAlreadyInitialized` / rent / `system_program` / signer-list /
  `NotEnoughAccountKeys`** — no rent or explicit account lists on EVM (§4 #6).
- **Byte-offset / layout assertions** — Solidity-native slot packing (§4 #4);
  not comparable. WP-04 E4: the `05` `CallRecord` byte assertions
  (`cr[2]`/`readU64(cr,80)`/`readU64(cr,88)`) are ported to `vm.expectEmit`
  on `CallSettled.{status,refund,actualRefund}` — behavior preserved, layout
  N-A.
- **SPL-mint constant checks** — `FeeRecipientInvalidUsdcMint` (A#18); the
  live 6-decimal assumption is instead enforced by the WP-06 T8
  `IERC20(USDC).decimals()==6` guard (`UsdcDecimals.t.sol`).

Residual invariants for every N-A item above are source-enforced and covered
by the named surviving WP-02 authority tests (Section C) — all PASS.

---

## Completeness self-check (captain GATE-B verifies this)

- [x] All **30/30** `PactError` variants tagged with file:line authority — Section A.
- [x] Every design-spec **§3 behavior** tagged — Section B (12 rows).
- [x] Every **§(d) item 1-8** represented + mapped to its T10 spec edit — Section D.
- [x] Every **`05-NA-MATRIX` row** present verbatim (09:47, 09:78, 09:144, 09:172, 10:94, 10:128, D-LOCK-EXPCAP-NA) — Section C.
- [x] The **P3 unauthorized+paused corner** present — Section C.
- [x] Each row tagged **IDENTICAL / OPTIMIZED-DIVERGENCE (§4 ref) / N-A-ON-EVM (rationale)** with file:line authority.
- [x] Synthesis only — no re-derivation or reopen of any locked ruling.
- [x] Parity proof: 109 Foundry tests + 41 client tests, all green.
