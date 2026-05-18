# WP-EVM-05 N-A-ON-EVM Matrix

**Status:** Complete (2026-05-18)
**Purpose:** Records every N-A-ON-EVM scenario from the 05-CONTEXT.md PORT/N-A table with a
one-line rationale for the WP-06 parity matrix, plus the named WP-02 surviving-invariant test
that confirms the residual behavior is source-enforced. Also records the P3 OPTIMIZED-DIVERGENCE
corner and the bounded adversarial-pass review required by 05-GATE-A-DECISIONS.md.

All surviving-invariant tests are confirmed PASSING in the WP-02/05 regression
(`forge test --match-contract PactRegistry --match-test "RejectsNonAuthority"` — all 4 pass).

---

## N-A-ON-EVM Scenario Table

| Source scenario | Disposition | Rationale (1 line for WP-06 parity matrix) | Surviving invariant test |
|---|---|---|---|
| 09:47 — pause_endpoint rejects fake ProtocolConfig at wrong address | N-A-ON-EVM | PDA-address spoofing is not possible on EVM — all privileged mutators are onlyAuthority (single address authority field); the authority-revert invariant is source-enforced and already tested in WP-02. | test_PauseEndpoint_RejectsNonAuthority |
| 09:78 — pause_endpoint rejects ProtocolConfig at canonical address with wrong owner | N-A-ON-EVM | PDA-owner spoofing is not possible on EVM — all privileged mutators are onlyAuthority (single address authority field); the authority-revert invariant is source-enforced and already tested in WP-02. | test_PauseEndpoint_RejectsNonAuthority |
| 09:144 — update_endpoint_config rejects fake ProtocolConfig at wrong address | N-A-ON-EVM | PDA-address spoofing is not possible on EVM — all privileged mutators are onlyAuthority (single address authority field); the authority-revert invariant is source-enforced and already tested in WP-02. | test_UpdateEndpointConfig_RejectsNonAuthority |
| 09:172 — update_fee_recipients rejects fake Treasury PDA | N-A-ON-EVM | Treasury PDA spoofing is not possible on EVM — treasuryVault is an immutable address set at construction; all privileged mutators are onlyAuthority; the authority-revert invariant is source-enforced and already tested in WP-02. | test_UpdateFeeRecipients_RejectsNonAuthority |
| 10:94 — pause_protocol rejects fake ProtocolConfig at wrong address | N-A-ON-EVM | PDA-address spoofing is not possible on EVM — all privileged mutators are onlyAuthority (single address authority field); the authority-revert invariant is source-enforced and already tested in WP-02. | test_PauseProtocol_RejectsNonAuthority |
| 10:128 — pause_protocol rejects ProtocolConfig at canonical address with wrong owner | N-A-ON-EVM | PDA-owner spoofing is not possible on EVM — all privileged mutators are onlyAuthority (single address authority field); the authority-revert invariant is source-enforced and already tested in WP-02. | test_PauseProtocol_RejectsNonAuthority |
| D-LOCK-EXPCAP-NA — ExposureCapExceeded error in settle path | N-A-ON-EVM | No settle_batch trigger: the cap clamps the refund to a status (ExposureCapClamped), it does not revert an "exceeded" error. The Solana error.rs:6002 ExposureCapExceeded variant is unreachable from settle_batch.rs — the cap block always clamps, never rejects. | N/A (no revert path exists; the clamp behavior is tested by test_ExposureCapClamped_PartialActualRefund and test_ExposureCap_CumulativeClampAcrossBatches) |

---

## P3 OPTIMIZED-DIVERGENCE Corner (WP-06 Parity Matrix Entry)

**Scenario:** unauthorized caller AND protocol is paused.

**Solana behavior (settle_batch.rs:99-115 before :117-130):** The protocol-paused check fires
at :99-115 BEFORE the full settler-identity check at :117-130. An unauthorized caller who also
encounters a paused protocol receives ProtocolPaused.

**EVM behavior:** settleBatch carries the onlyRole(SETTLER_ROLE) modifier (WP-04 E2, LOCKED).
Solidity modifiers execute before the function body. An unauthorized caller hits
AccessControlUnauthorizedAccount before the body's ProtocolPaused check, regardless of protocol
state.

**Operationally-real path (authorized settler + paused):** Both chains return ProtocolPaused
identically. This is the only path that matters in production.

**Disposition:** OPTIMIZED-DIVERGENCE. Captain-ratified (05-GATE-A-DECISIONS.md P3). The
alternative — restructuring to an in-body _checkRole placed after the pause check — would
require rewriting the WP-04 seam-pinned settleBatch signature and shape, which is forbidden
(D-LOCK-6; no WP-04 reopen). The divergence is confined to the unauthorized-caller-AND-paused
corner, which is operationally meaningless (an unauthorized caller is never a legitimate settler).

**Tests written:** test_ProtocolPaused_RejectsSettleBatch (authorized settler + paused ->
ProtocolPaused) and test_ProtocolPaused_ResumesAfterUnpause (resume after unpause -> success).
No test is written asserting Solana behavior for the unauthorized+paused corner — EVM
intentionally diverges there per captain ruling.

---

## Bounded Adversarial-Pass Review (05-GATE-A-DECISIONS.md — brief, 3 vectors, not a fuzz suite)

The captain approved a brief manual adversarial review scoped to the 4 WP-05 seams. Three
vectors were reviewed. Findings are recorded below.

### Vector 1: Cross-agent cap saturation — another agent's endpoint ExposureCapClamped in one batch (currentPeriodRefunds > exposureCap => cap_remaining = 0 boundary)

**Review:** The exposure cap is per-endpoint (keyed by slug via the mapping in PactRegistry).
A batch containing multiple events for different agents sharing the same endpoint slug will each
call recordCallAndCapAccrual sequentially. The first event to exhaust the cap sets
currentPeriodRefunds = exposureCap. Subsequent events in the same batch find cap_remaining = 0
(saturating_sub: exposureCapPerHour > currentPeriodRefunds ? ... : 0 = 0). The clamp sets
payableRefund = 0, which means the P1 inference (payableRefund < ev.refund) fires only if
ev.refund > 0 (breach). This is correct and parity-exact to Solana saturating_sub semantics.

**Boundary case (currentPeriodRefunds > exposureCap):** On EVM, currentPeriodRefunds is
accumulated only via _ckAdd (overflow-checked) and can never exceed exposureCap by accumulation
alone — the cap clamp prevents accruing more than cap_remaining per call. However, if
exposureCapPerHour is lowered after some accrual (via updateEndpointConfig), it is possible for
currentPeriodRefunds to exceed the new exposureCapPerHour. The ternary guard handles this:
when ep.exposureCapPerHour <= ep.currentPeriodRefunds, capRemaining = 0, and every breach
event clamps to 0 (ExposureCapClamped with actualRefund=0). This is the saturatingSub=0
boundary case tested by test_ExposureCap_CumulativeClampAcrossBatches (adversarial vector 1,
third batch). No new vulnerability found.

**Finding:** CLEAN. The saturatingSub=0 boundary is already tested by
test_ExposureCap_CumulativeClampAcrossBatches (05-04). No additional test needed.

### Vector 2: Empty-batch (events.length == 0) pause-bypass

**Review:** If events.length == 0, the settleBatch function:
1. Passes the onlyRole(SETTLER_ROLE) modifier check.
2. Evaluates if (registry.protocolPaused()) revert ProtocolPaused() — this FIRES if paused.
3. Evaluates if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge() — 0 > 50 is
   false, so no revert.
4. Enters the for loop with events.length == 0 — the loop body never executes.
5. Returns without emitting any CallSettled events.

An empty batch does NOT bypass the protocol-paused check (step 2). If the protocol is paused,
the function reverts ProtocolPaused. If the protocol is live, the call succeeds but is a no-op.
This mirrors Solana: settle_batch.rs:99-115 fires before the loop, so event_count=0 still hits
the protocol-paused guard. The BatchTooLarge guard uses strictly-greater, so 0 events is always
within bounds. No reentrancy or state mutation from the no-op path (no external calls are made
when events.length == 0).

**Finding:** CLEAN. No pause-bypass vector. Empty batch is a benign no-op when live, and still
reverts ProtocolPaused when paused. No additional test needed — the existing
test_ProtocolPaused_RejectsSettleBatch covers the pause check before the loop.

### Vector 3: Reentrancy via registry.protocolPaused() or pool hooks on PoolDepleted path

**Review:** Three external call sites in the WP-05 seams:
1. registry.protocolPaused() — read-only view call on PactRegistry. No state is mutated by
   PactRegistry during this call. PactRegistry does not call back into PactSettler.
2. registry.getEndpoint(ev.endpointSlug) — read-only view call returning a memory struct.
   No state mutation, no callback.
3. registry.recordCallAndCapAccrual(...) — state-mutating call on PactRegistry. PactRegistry
   updates EndpointConfig fields (stats, currentPeriodRefunds) and returns payableRefund.
   PactRegistry does not call back into PactSettler or PactPool during this function.

The PoolDepleted path (ps.currentBalance < payableRefund in the if branch) does NOT call
pool.payout or pool.debitForRefund — those are in the else branch. The PoolDepleted branch
sets status and actualRefund=0 only. No external calls are made on the PoolDepleted path.
The only external call on the refund path is pool.payout (in the else branch), which is a
trusted internal contract (PactPool), not an untrusted external. PactPool does not reenter
PactSettler.

CEI (Checks-Effects-Interactions) order: the dedup mapping _settledCallIds[ev.callId] is set
at PactSettler.sol:98 (the dedup SET) AFTER the checks and BEFORE the interactions (premium-in
at :106 and then _settleSuccess at the end of the loop body). This is not strictly CEI
(effects before interactions is correct; here the dedup is set before the external call, which
is the correct protection). A reentrant call via the pool's payout would find the callId already
consumed in _settledCallIds and revert DuplicateCallId. No reentrancy vector found.

**Finding:** CLEAN. No reentrancy vector via registry.protocolPaused(), pool hooks, or the
PoolDepleted path. No additional test needed.

---

## WP-02 Surviving-Invariant Test Confirmation

Confirmed live via `forge test --match-contract PactRegistry --match-test "RejectsNonAuthority"`:

| Test | Contract | Result |
|---|---|---|
| test_PauseEndpoint_RejectsNonAuthority | PactRegistryTest | PASS |
| test_PauseProtocol_RejectsNonAuthority | PactRegistryTest | PASS |
| test_UpdateEndpointConfig_RejectsNonAuthority | PactRegistryTest | PASS |
| test_UpdateFeeRecipients_RejectsNonAuthority | PactRegistryTest | PASS |

All 4 surviving-invariant tests pass. The authority-revert invariant is live and source-enforced.

---

## PORT Coverage Summary (all PORT rows green — no gaps)

| Source scenario | Covering test | Plan |
|---|---|---|
| 05:442 PoolDepleted | test_PoolDepleted_RefundSkippedAndMarked | 05-05 |
| 05:485 ExposureCapClamped | test_ExposureCapClamped_PartialActualRefund | 05-04 |
| 05:529 ProtocolPaused rejects | test_ProtocolPaused_RejectsSettleBatch | 05-02 |
| 05:595 resume after unpause | test_ProtocolPaused_ResumesAfterUnpause | 05-02 |
| 06:12/34 pause_endpoint set/unset | test_PauseEndpoint_SetsPaused / test_PauseEndpoint_CanUnpause | WP-02 (PactRegistry.t.sol) |
| 06:55 pause_endpoint non-authority | test_PauseEndpoint_RejectsNonAuthority | WP-02 (PactRegistry.t.sol) |
| 06 EndpointPaused per-event | test_EndpointPaused_RevertsPerEvent | 05-03 |
| 06 EndpointPaused resume | test_EndpointPaused_CanResumeAfterUnpause | 05-03 |
| 06 D-LOCK-PREC: dedup before EndpointPaused | test_EndpointPaused_DedupReadPrecedesEndpointPaused | 05-03 |
| 07:25 cumulative cap clamp (both sub-cases) | test_ExposureCap_CumulativeClampAcrossBatches | 05-04 |
| 07:81 1-hour reset | test_ExposureCap_ResetsAfter1Hour | 05-05 |
| 10:28 pause_protocol toggle | test_PauseProtocol_SetAndClear | WP-02 (PactRegistry.t.sol) |
| 10:72 pause_protocol non-authority | test_PauseProtocol_RejectsNonAuthority | WP-02 (PactRegistry.t.sol) |
| BatchTooLarge 51-event | test_BatchTooLarge_51EventsRevert | 05-02 |
| BatchTooLarge 50-event boundary | test_BatchTooLarge_50EventsAccepted | 05-02 |

No WP-02 registry-side scenario (06:12/34/55, 10:28/72) is re-implemented in PactSettler.t.sol.
`grep -c "function test_PauseEndpoint_SetsPaused\|function test_PauseProtocol_SetAndClear" test/PactSettler.t.sol` == 0 (confirmed).
