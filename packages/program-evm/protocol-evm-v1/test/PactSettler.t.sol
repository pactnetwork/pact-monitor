// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PactSettler} from "../src/PactSettler.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {IPactSettler} from "../src/interfaces/IPactSettler.sol";
import {IPactPool} from "../src/interfaces/IPactPool.sol";
import {PactEvents} from "../src/PactEvents.sol";
import {ArcConfig} from "../src/ArcConfig.sol";
import {MockUSDC} from "./util/MockUSDC.sol";
import "../src/errors/PactErrors.sol";

/// @notice WP-EVM-04 harness — PactSettler AccessControl + E1 endpoint-stats
///         hooks + shared setUp/helpers mirroring helpers.ts.
///         Tasks 1/2/3 TDD tests all live here.
contract PactSettlerTest is Test {
    MockUSDC usdc;
    PactRegistry reg;
    PactPool pool;
    PactSettler settler;

    address authority     = makeAddr("authority");
    address treasuryVault = makeAddr("treasuryVault");
    address settlerSigner = makeAddr("settlerSigner");

    /// @dev Cached BEFORE any vm.prank (pitfall 3 — RESEARCH §Common Pitfalls).
    bytes32 poolSettlerRole;
    bytes32 regSettlerRole;
    bytes32 settlerRole;

    bytes16 constant SLUG   = bytes16("helius");
    bytes16 constant SLUG_B = bytes16("jupiter");
    bytes16 constant SLUG_C = bytes16("birdeye");

    // -----------------------------------------------------------------------
    // Shared setUp (Task 3 full harness — called for all tests)
    // -----------------------------------------------------------------------

    function setUp() public {
        usdc = new MockUSDC();

        // Default fee template: Treasury 10 % (1000 bps).
        IPactRegistry.FeeRecipient[8] memory d;
        d[0].kind = 0;
        d[0].destination = treasuryVault;
        d[0].bps = 1000;

        reg = new PactRegistry(authority, address(usdc), treasuryVault, 3000, d, 1);
        pool = new PactPool(address(usdc), address(reg));
        settler = new PactSettler(address(usdc), address(reg), address(pool));

        // Cache role constants BEFORE any vm.prank.
        poolSettlerRole = pool.SETTLER_ROLE();
        regSettlerRole  = reg.SETTLER_ROLE();
        settlerRole     = settler.SETTLER_ROLE();

        // E1xE2 TWO-LAYER GRANT — deployed PactSettler holds SETTLER_ROLE on
        // BOTH pool AND registry (per GATE-A E2 INTERPLAY ruling).
        vm.prank(authority);
        pool.grantRole(poolSettlerRole, address(settler));
        vm.prank(authority);
        reg.grantRole(regSettlerRole, address(settler));
        // Grant settlerSigner the right to call settler.settleBatch (SET-01).
        vm.prank(authority);
        settler.grantRole(settlerRole, settlerSigner);
    }

    // -----------------------------------------------------------------------
    // Task 1 — Deploy / role wiring (GATE-A E2)
    // -----------------------------------------------------------------------

    /// @notice GATE-A E2: DEFAULT_ADMIN_ROLE -> registry.authority(),
    ///         SETTLER_ROLE constant = keccak256("SETTLER_ROLE"),
    ///         settlerSigner holds role after setUp grant.
    function test_Deploy_WiresSettlerRoleAndAdmin() public view {
        // DEFAULT_ADMIN_ROLE (0x00) granted to registry.authority() in ctor.
        assertTrue(settler.hasRole(0x00, authority));
        // SETTLER_ROLE constant matches the expected literal.
        assertEq(settler.SETTLER_ROLE(), keccak256("SETTLER_ROLE"));
        // settlerSigner now holds SETTLER_ROLE (granted in setUp).
        assertTrue(settler.hasRole(settler.SETTLER_ROLE(), settlerSigner));
    }

    // -----------------------------------------------------------------------
    // Task 2 — E1 endpoint-stats hooks (GATE-A E1, OPTION (a))
    //
    // RED failures confirmed before GREEN:
    //   "Member 'recordCallAndCapAccrual' not found..."
    //   "Member 'recordRefundPaid' not found..."
    //   "Member 'SETTLER_ROLE' not found on PactRegistry"
    // -----------------------------------------------------------------------

    /// @notice settle_batch.rs:385-499 — calls/premiums/breaches accumulate;
    ///         recordRefundPaid accumulates totalRefunds (ACTUAL) separately.
    function test_EndpointStats_RecordCallAccumulates() public {
        _register(SLUG);

        // Call 1: non-breach, no refund.
        vm.prank(address(settler));
        uint64 ret = reg.recordCallAndCapAccrual(SLUG, 1000, false, 0);
        assertEq(ret, 0, "payableRefund mismatch call1");

        IPactRegistry.EndpointConfig memory ep = reg.getEndpoint(SLUG);
        assertEq(ep.totalCalls, 1);
        assertEq(ep.totalPremiums, 1000);
        assertEq(ep.totalBreaches, 0);
        assertEq(ep.totalRefunds, 0);
        assertEq(ep.currentPeriodRefunds, 0);

        // Call 2: breach, intendedRefund = 500.
        vm.prank(address(settler));
        ret = reg.recordCallAndCapAccrual(SLUG, 2000, true, 500);
        assertEq(ret, 500, "payableRefund mismatch call2 (WP-04 = intendedRefund, no clamp)");

        ep = reg.getEndpoint(SLUG);
        assertEq(ep.totalCalls, 2);
        assertEq(ep.totalPremiums, 3000);
        assertEq(ep.totalBreaches, 1);
        assertEq(ep.currentPeriodRefunds, 500, "currentPeriodRefunds after HOOK 1");
        assertEq(ep.totalRefunds, 0, "totalRefunds still 0 - HOOK 2 not yet called");

        // HOOK 2: recordRefundPaid accumulates ACTUAL paid amount.
        vm.prank(address(settler));
        reg.recordRefundPaid(SLUG, 500);

        ep = reg.getEndpoint(SLUG);
        assertEq(ep.totalRefunds, 500, "totalRefunds after HOOK 2");
    }

    /// @notice Non-settler caller invoking recordCallAndCapAccrual reverts
    ///         AccessControlUnauthorizedAccount (condition (1) role gate).
    function test_EndpointStats_RecordCallRejectsNonSettler() public {
        _register(SLUG);
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                nobody,
                regSettlerRole
            )
        );
        reg.recordCallAndCapAccrual(SLUG, 1000, false, 0);
    }

    /// @notice Non-settler caller invoking recordRefundPaid reverts
    ///         AccessControlUnauthorizedAccount (HOOK 2 is also SETTLER_ROLE-gated).
    function test_EndpointStats_RecordRefundPaidRejectsNonSettler() public {
        _register(SLUG);
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                nobody,
                regSettlerRole
            )
        );
        reg.recordRefundPaid(SLUG, 100);
    }

    /// @notice settle_batch.rs:396-399 — period reset: after > 3600 s, the
    ///         currentPeriodStart advances and currentPeriodRefunds resets to 0
    ///         THEN accumulates the NEW call's refund (not 700, but 400).
    function test_EndpointStats_PeriodReset() public {
        _register(SLUG);

        // First call within initial period: intendedRefund = 300.
        vm.prank(address(settler));
        reg.recordCallAndCapAccrual(SLUG, 1000, true, 300);
        assertEq(reg.getEndpoint(SLUG).currentPeriodRefunds, 300);

        uint64 storedStart = reg.getEndpoint(SLUG).currentPeriodStart;

        // Warp > 3600 s past the stored start to trigger the period reset.
        vm.warp(uint256(storedStart) + 3601);

        vm.prank(address(settler));
        reg.recordCallAndCapAccrual(SLUG, 1000, true, 400);

        IPactRegistry.EndpointConfig memory ep = reg.getEndpoint(SLUG);
        // currentPeriodStart must advance to the warped block.timestamp.
        assertEq(ep.currentPeriodStart, uint64(block.timestamp), "period start did not advance");
        // currentPeriodRefunds = 400, NOT 700 (reset then re-accumulated).
        assertEq(ep.currentPeriodRefunds, 400, "currentPeriodRefunds must be 400 after reset");
    }

    /// @notice Within the same hour, currentPeriodRefunds accumulates;
    ///         currentPeriodStart does NOT change.
    function test_EndpointStats_WithinWindowAccumulates() public {
        _register(SLUG);

        uint64 storedStart = reg.getEndpoint(SLUG).currentPeriodStart;

        // Warp 1000 s — still within the 3600 s window.
        vm.warp(uint256(storedStart) + 1000);

        vm.prank(address(settler));
        reg.recordCallAndCapAccrual(SLUG, 1000, true, 300);

        vm.prank(address(settler));
        reg.recordCallAndCapAccrual(SLUG, 1000, true, 400);

        IPactRegistry.EndpointConfig memory ep = reg.getEndpoint(SLUG);
        // Accumulates: 300 + 400 = 700.
        assertEq(ep.currentPeriodRefunds, 700, "should accumulate within window");
        // currentPeriodStart unchanged from register time.
        assertEq(ep.currentPeriodStart, storedStart, "start must not change within window");
    }

    /// @notice recordRefundPaid accumulates ACTUAL paid amount independently.
    function test_EndpointStats_RecordRefundPaidAccumulates() public {
        _register(SLUG);

        vm.prank(address(settler));
        reg.recordRefundPaid(SLUG, 200);
        vm.prank(address(settler));
        reg.recordRefundPaid(SLUG, 300);

        assertEq(reg.getEndpoint(SLUG).totalRefunds, 500);
    }

    // -----------------------------------------------------------------------
    // Task 3 — Shared harness helpers (mirroring helpers.ts)
    // -----------------------------------------------------------------------

    /// @dev helpers.ts registerSimpleEndpoint defaults: flatPremium=500,
    ///      percentBps=0, slaMs=5000, imputedCost=1000, exposureCap=5_000_000.
    function _register(bytes16 slug) internal {
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(slug, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    /// @dev Register with explicit fee recipients (for 85/10/5 and
    ///      mixed-3-endpoint tests).
    function _registerWithRecipients(
        bytes16 slug,
        IPactRegistry.FeeRecipient[8] memory r,
        uint8 n
    ) internal {
        vm.prank(authority);
        reg.registerEndpoint(slug, 500, 0, 5000, 1000, 5_000_000, true, n, r);
    }

    /// @dev mirrors fundPoolDirect: mint -> approve -> topUp.
    function _fundPool(bytes16 slug, uint64 amount) internal {
        usdc.mint(authority, amount);
        vm.prank(authority);
        usdc.approve(address(pool), amount);
        vm.prank(authority);
        pool.topUp(slug, amount);
    }

    /// @dev mirrors provisionAgent: mint -> approve settler as spender
    ///      (§4#5: settler is the ERC-20 spender, NOT the pool).
    function _provisionAgent(address agent, uint64 mintAmount, uint64 allowance) internal {
        usdc.mint(agent, mintAmount);
        vm.prank(agent);
        usdc.approve(address(settler), allowance);
    }

    /// @dev Build a SettlementEvent struct mirroring 05-settle-batch.test.ts
    ///      fields. callId fills bytes16 from a uint8 seed.
    function _makeEvent(
        uint8 seed,
        address agent,
        bytes16 slug,
        uint64 premium,
        uint64 refund,
        uint32 latencyMs,
        bool breach,
        uint8 feeCountHint,
        uint64 tsOffset
    ) internal view returns (IPactSettler.SettlementEvent memory ev) {
        // Fill callId with seed byte repeated.
        bytes16 callId;
        bytes memory b = new bytes(16);
        for (uint256 i = 0; i < 16; i++) b[i] = bytes1(seed);
        assembly { callId := mload(add(b, 32)) }

        ev = IPactSettler.SettlementEvent({
            callId:               callId,
            agent:                agent,
            endpointSlug:         slug,
            premium:              premium,
            refund:               refund,
            latencyMs:            latencyMs,
            breach:               breach,
            feeRecipientCountHint: feeCountHint,
            timestamp:            uint64(block.timestamp) - tsOffset
        });
    }

    // -----------------------------------------------------------------------
    // Task 1 (04-03) — SET-01 + SET-03 guard tests
    // Ported from 05-settle-batch.test.ts tests 6, 8 + extra guard coverage.
    // -----------------------------------------------------------------------

    /// @notice 05 test 8: unauthorized settler rejected (SET-01).
    ///         settle_batch.rs:95-97 (is_signer) → EVM onlyRole(SETTLER_ROLE).
    ///         Mirrors PactPool.t.sol test_Hooks_RejectNonSettler pattern.
    function test_UnauthorizedSettlerRejected() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x50, agent, SLUG, 1_000, 0, 0, false, 1, 1);

        address fake = makeAddr("fake");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                fake,
                settlerRole  // cached in setUp() before any vm.prank (pitfall 3)
            )
        );
        vm.prank(fake);
        settler.settleBatch(events);
    }

    /// @notice 05 test 6: min-premium edge — premium < MIN_PREMIUM rejected
    ///         (SET-03). settle_batch.rs:161-163.
    function test_MinPremiumEdgeRejected() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // premium = 50 < ArcConfig.MIN_PREMIUM (100)
        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x1e, agent, SLUG, 50, 0, 0, false, 1, 1);

        vm.prank(settlerSigner);
        vm.expectRevert(PremiumTooSmall.selector);
        settler.settleBatch(events);
    }

    /// @notice timestamp > now rejected (SET-03). settle_batch.rs:158-160.
    function test_InvalidTimestampRejected() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        // timestamp = block.timestamp + 1 (future)
        events[0] = IPactSettler.SettlementEvent({
            callId:               bytes16(uint128(0xAA)),
            agent:                agent,
            endpointSlug:         SLUG,
            premium:              1_000,
            refund:               0,
            latencyMs:            0,
            breach:               false,
            feeRecipientCountHint: 1,
            timestamp:            uint64(block.timestamp) + 1
        });

        vm.prank(settlerSigner);
        vm.expectRevert(InvalidTimestamp.selector);
        settler.settleBatch(events);
    }

    /// @notice feeRecipientCountHint != stored feeRecipientCount reverts
    ///         RecipientCoverageMismatch (SET-03). settle_batch.rs:212-215.
    ///         _register stores feeRecipientCount=0 (no override), but the
    ///         protocol default fee template has 1 recipient — the registry
    ///         resolves to 1. Hint=2 mismatches.
    function test_RecipientCoverageMismatchRejected() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // stored feeRecipientCount = 1 (protocol default Treasury), hint = 2
        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0xBB, agent, SLUG, 1_000, 0, 0, false, 2, 1);

        vm.prank(settlerSigner);
        vm.expectRevert(RecipientCoverageMismatch.selector);
        settler.settleBatch(events);
    }

    // -----------------------------------------------------------------------
    // Task 1 (04-04) — Economic happy path tests (SET-05/06/07/08)
    // Ported from 05-settle-batch.test.ts
    // -----------------------------------------------------------------------

    /// @notice 05 test 1: single event with default 10% Treasury fan-out.
    ///         settle_batch.rs:357-522 full economic loop.
    ///         RED: fails because provisional seam emits actualRefund=0 +
    ///         no pool credit / no fee fan-out / no endpoint stats.
    function test_SingleEventDefaultTreasuryFanOut() public {
        address agent = makeAddr("agent");
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        uint64 ts = uint64(block.timestamp) - 1;
        events[0] = _makeEvent(0x01, agent, SLUG, 10_000, 0, 100, false, 1, 1);

        bytes16 callId = events[0].callId;

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            callId, SLUG, agent,
            10_000, 0, 0,
            IPactSettler.SettlementStatus.Settled,
            false, 100, ts
        );

        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Agent paid full premium.
        assertEq(usdc.balanceOf(agent), 10_000_000 - 10_000, "agent balance");
        // Pool USDC = 5_000_000 + 10_000 (gross credit) - 1_000 (Treasury 10%) = 5_009_000
        assertEq(usdc.balanceOf(address(pool)), 5_000_000 + 9_000, "pool usdc");
        // Treasury received 10% of premium.
        assertEq(usdc.balanceOf(treasuryVault), 1_000, "treasury");
        // Pool accounting.
        IPactPool.PoolState memory ps = pool.balanceOf(SLUG);
        assertEq(ps.currentBalance, 5_000_000 + 9_000, "pool.currentBalance");
        // Endpoint stats.
        IPactRegistry.EndpointConfig memory ep = reg.getEndpoint(SLUG);
        assertEq(ep.totalCalls, 1, "totalCalls");
        assertEq(ep.totalPremiums, 10_000, "totalPremiums");
    }

    // -----------------------------------------------------------------------
    // Task 2 (04-03) — SET-04 dedup mapping + SET-02 premium-in DelegateFailed
    // Ported from 05-settle-batch.test.ts tests 5 + 7.
    // -----------------------------------------------------------------------

    /// @notice 05 test 7: duplicate call_id rejected (SET-04).
    ///         settle_batch.rs:194-196. First settle succeeds; second identical
    ///         callId reverts DuplicateCallId.
    function test_DuplicateCallIdRejected() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x28, agent, SLUG, 1_000, 0, 0, false, 1, 1);

        // First settle — must not revert.
        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Second settle with identical callId — must revert DuplicateCallId.
        vm.prank(settlerSigner);
        vm.expectRevert(DuplicateCallId.selector);
        settler.settleBatch(events);
    }

    /// @notice GATE-B precedence pin (parity): an event that is SIMULTANEOUSLY
    ///         a replayed/duplicate callId AND has feeRecipientCountHint !=
    ///         stored ep.feeRecipientCount MUST revert DuplicateCallId — NOT
    ///         RecipientCoverageMismatch. Mirrors settle_batch.rs ordering:
    ///         the dedup check (:194 `!call_record.is_data_empty()`) fires
    ///         BEFORE the endpoint-snapshot RecipientCoverageMismatch (:213
    ///         `ep_count != fee_count_hint`). Same input -> same error as
    ///         Solana (precedence parity; not a §4-ledger divergence).
    function test_DuplicateCallIdPrecedesRecipientCoverageMismatch() public {
        _register(SLUG); // stored feeRecipientCount resolves to 1 (default Treasury)
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // First settle — valid (hint = stored count = 1) — consumes the callId.
        IPactSettler.SettlementEvent[] memory first = new IPactSettler.SettlementEvent[](1);
        first[0] = _makeEvent(0x99, agent, SLUG, 1_000, 0, 0, false, 1, 1);
        vm.prank(settlerSigner);
        settler.settleBatch(first);

        // Second event: SAME callId (0x99) AND feeRecipientCountHint = 2 !=
        // stored 1 — BOTH DuplicateCallId AND RecipientCoverageMismatch apply.
        // settle_batch.rs:194 precedes :213 -> MUST revert DuplicateCallId.
        IPactSettler.SettlementEvent[] memory second = new IPactSettler.SettlementEvent[](1);
        second[0] = _makeEvent(0x99, agent, SLUG, 1_000, 0, 0, false, 2, 1);
        vm.prank(settlerSigner);
        vm.expectRevert(DuplicateCallId.selector);
        settler.settleBatch(second);
    }

    /// @notice 05 test 5: revoke between events — DelegateFailed and continues
    ///         (SET-02). Tests:
    ///         (a) second batch does NOT revert as a tx,
    ///         (b) agent balance unchanged (no funds moved),
    ///         (c) exactly one IPactSettler.CallSettled emitted with
    ///             status == DelegateFailed (GATE-A E3: only IPactSettler event),
    ///         (d) retry of the same callId reverts DuplicateCallId (GATE-A E4:
    ///             dedup mapping set even on DelegateFailed).
    function test_RevokeMarksDelegateFailedAndContinues() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // First batch: callId fill(20), premium=1_000 — succeeds.
        IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
        ev1[0] = _makeEvent(0x14, agent, SLUG, 1_000, 0, 0, false, 1, 1);

        vm.prank(settlerSigner);
        settler.settleBatch(ev1);

        uint256 balanceAfterFirst = usdc.balanceOf(agent);

        // Revoke: set allowance to 0 so transferFrom fails.
        vm.prank(agent);
        usdc.approve(address(settler), 0);

        // Second batch: callId fill(21), premium=1_000.
        IPactSettler.SettlementEvent[] memory ev2 = new IPactSettler.SettlementEvent[](1);
        ev2[0] = _makeEvent(0x15, agent, SLUG, 1_000, 0, 0, false, 1, 1);

        // (c) expect exactly one CallSettled with DelegateFailed.
        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev2[0].callId,
            ev2[0].endpointSlug,
            ev2[0].agent,
            ev2[0].premium,
            ev2[0].refund,
            0,                                        // actualRefund = 0 on DelegateFailed
            IPactSettler.SettlementStatus.DelegateFailed,
            ev2[0].breach,
            ev2[0].latencyMs,
            ev2[0].timestamp
        );

        // (a) must NOT revert as a tx.
        vm.prank(settlerSigner);
        settler.settleBatch(ev2);

        // (b) agent balance unchanged — no premium deducted.
        assertEq(usdc.balanceOf(agent), balanceAfterFirst, "agent balance must be unchanged on DelegateFailed");

        // (d) retry same callId fill(21) -> DuplicateCallId (dedup set even on failure).
        vm.prank(settlerSigner);
        vm.expectRevert(DuplicateCallId.selector);
        settler.settleBatch(ev2);
    }

    // -----------------------------------------------------------------------
    // Task 2 (04-04) — remaining 5 happy-path tests ported from
    // 05-settle-batch.test.ts (tests 2, 3, 4, 9) + ABI-identity assertion.
    // Numbers copied VERBATIM from the Solana oracle — no recomputation.
    // -----------------------------------------------------------------------

    /// @notice 05 test 2: single event with explicit Treasury 10% + Affiliate 5%.
    ///         split = 85/10/5. Numbers: treasury==10_000, aff==5_000,
    ///         pool==5_085_000, agent==9_900_000.
    function test_SingleEventExplicit85_10_5Split() public {
        address affAddr = makeAddr("affAddr");

        IPactRegistry.FeeRecipient[8] memory r;
        r[0].kind = 0;        // Treasury
        r[0].destination = treasuryVault;
        r[0].bps = 1000;      // 10%
        r[1].kind = 1;        // AffiliateAta
        r[1].destination = affAddr;
        r[1].bps = 500;       // 5%

        _registerWithRecipients(SLUG_B, r, 2);
        _fundPool(SLUG_B, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x02, agent, SLUG_B, 100_000, 0, 100, false, 2, 1);

        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Treasury 10% of 100_000 = 10_000.
        assertEq(usdc.balanceOf(treasuryVault), 10_000, "treasury");
        // Affiliate 5% of 100_000 = 5_000.
        assertEq(usdc.balanceOf(affAddr), 5_000, "affAddr");
        // Pool USDC = 5_000_000 + 100_000 - 10_000 - 5_000 = 5_085_000.
        assertEq(usdc.balanceOf(address(pool)), 5_000_000 + 85_000, "pool usdc");
        // Agent debited full premium.
        assertEq(usdc.balanceOf(agent), 10_000_000 - 100_000, "agent balance");
    }

    /// @notice 05 test 3: breach event refunds agent ATA from pool vault.
    ///         Numbers: agent==10_049_000, pool==4_950_900, treasury==100,
    ///         CallSettled(Settled, refund=50_000, actualRefund=50_000).
    ///         Also confirms two-hook wiring: currentPeriodRefunds==50_000 (ep
    ///         point 1, pre-fan-out) and totalRefunds==50_000 (ep point 2,
    ///         post-transfer).
    function test_BreachRefundsAgentFromPool() public {
        address agent = makeAddr("agent");
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        // callId fill(3), premium=1_000, refund=50_000, breach=true, latencyMs=6000
        events[0] = _makeEvent(0x03, agent, SLUG, 1_000, 50_000, 6000, true, 1, 1);

        bytes16 callId = events[0].callId;
        uint64 ts = events[0].timestamp;

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            callId, SLUG, agent,
            1_000, 50_000, 50_000,
            IPactSettler.SettlementStatus.Settled,
            true, 6000, ts
        );

        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Agent: started 10_000_000, paid 1_000 premium, received 50_000 refund.
        assertEq(usdc.balanceOf(agent), 10_000_000 - 1_000 + 50_000, "agent balance");
        // Pool: 5_000_000 + 1_000 (credit) - 100 (Treasury 10% of 1_000) - 50_000 (refund) = 4_950_900.
        assertEq(usdc.balanceOf(address(pool)), 5_000_000 + 1_000 - 100 - 50_000, "pool usdc");
        // Treasury: 10% of 1_000 = 100.
        assertEq(usdc.balanceOf(treasuryVault), 100, "treasury");
        // Endpoint stats confirm two-hook wiring at correct source positions.
        IPactRegistry.EndpointConfig memory ep = reg.getEndpoint(SLUG);
        // ep point 1 (recordCallAndCapAccrual, BEFORE fee fan-out): currentPeriodRefunds accrued.
        assertEq(ep.currentPeriodRefunds, 50_000, "currentPeriodRefunds (ep point 1)");
        // ep point 2 (recordRefundPaid, AFTER transfer): totalRefunds == actual paid.
        assertEq(ep.totalRefunds, 50_000, "totalRefunds (ep point 2)");
    }

    /// @notice 05 test 4: mixed batch across 3 endpoints with different fee templates.
    ///         Numbers: agent==29_400_000, ep1.currentBalance==1_090_000,
    ///         ep2==1_180_000, ep3==1_299_970, treasury==20_030, aff2==10_000.
    function test_MixedBatch3Endpoints() public {
        address aff2Addr = makeAddr("aff2Addr");

        // EP1: default Treasury 10%.
        bytes16 slug1 = bytes16("ep1             ");
        _register(slug1);
        _fundPool(slug1, 1_000_000);

        // EP2: Treasury 500bps + Affiliate 500bps.
        bytes16 slug2 = bytes16("ep2             ");
        IPactRegistry.FeeRecipient[8] memory r2;
        r2[0].kind = 0; r2[0].destination = treasuryVault; r2[0].bps = 500;
        r2[1].kind = 1; r2[1].destination = aff2Addr;      r2[1].bps = 500;
        _registerWithRecipients(slug2, r2, 2);
        _fundPool(slug2, 1_000_000);

        // EP3: Treasury 1bps.
        bytes16 slug3 = bytes16("ep3             ");
        IPactRegistry.FeeRecipient[8] memory r3;
        r3[0].kind = 0; r3[0].destination = treasuryVault; r3[0].bps = 1;
        _registerWithRecipients(slug3, r3, 1);
        _fundPool(slug3, 1_000_000);

        address agent = makeAddr("agent");
        _provisionAgent(agent, 30_000_000, 30_000_000);

        // Warp to a realistic timestamp so tsOffset 3/2/1 don't underflow.
        vm.warp(1_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](3);
        events[0] = _makeEvent(0x0B, agent, slug1, 100_000, 0, 50, false, 1, 3);
        events[1] = _makeEvent(0x0C, agent, slug2, 200_000, 0, 50, false, 2, 2);
        events[2] = _makeEvent(0x0D, agent, slug3, 300_000, 0, 50, false, 1, 1);

        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Agent debited 100k+200k+300k = 600k.
        assertEq(usdc.balanceOf(agent), 30_000_000 - 600_000, "agent balance");
        // EP1 pool: +100k - 10k (Treasury 10%) = +90k => 1_090_000.
        assertEq(pool.balanceOf(slug1).currentBalance, 1_000_000 + 90_000, "ep1 balance");
        // EP2 pool: +200k - 10k (Treas 5%) - 10k (Aff 5%) = +180k => 1_180_000.
        assertEq(pool.balanceOf(slug2).currentBalance, 1_000_000 + 180_000, "ep2 balance");
        // EP3 pool: +300k - 30 (Treasury 1bps) = +299_970 => 1_299_970.
        assertEq(pool.balanceOf(slug3).currentBalance, 1_000_000 + 299_970, "ep3 balance");
        // Treasury: 10k (ep1) + 10k (ep2) + 30 (ep3) = 20_030.
        assertEq(usdc.balanceOf(treasuryVault), 20_030, "treasury");
        // Affiliate2: 10k (ep2 only).
        assertEq(usdc.balanceOf(aff2Addr), 10_000, "aff2");
    }

    /// @notice 05 test 9: happy path CallRecord settlement_status = Settled (0).
    ///         callId fill(80), premium=1_000, refund=50_000, breach=true.
    ///         vm.expectEmit ports cr[2]==0 (Settled), readU64(cr,80)==50_000,
    ///         readU64(cr,88)==50_000 per GATE-A E4.
    function test_HappyPathSettledStatusEvent() public {
        address agent = makeAddr("agent");
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x50, agent, SLUG, 1_000, 50_000, 6000, true, 1, 1);

        bytes16 callId = events[0].callId;
        uint64 ts = events[0].timestamp;

        // vm.expectEmit ports cr[2]==0 (Settled), readU64(cr,80)==50_000
        // (refund_lamports), readU64(cr,88)==50_000 (actual_refund_lamports)
        // per GATE-A E4 (EVM event-as-truth).
        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            callId, SLUG, agent,
            1_000, 50_000, 50_000,
            IPactSettler.SettlementStatus.Settled,  // cr[2] == 0
            true, 6000, ts
        );

        vm.prank(settlerSigner);
        settler.settleBatch(events);
    }

    /// @notice GATE-A E3 ABI-identity assertion: IPactSettler.CallSettled and
    ///         PactEvents.CallSettled have the SAME topic0 — 'alias' is literally
    ///         true; exactly one emission per call, single canonical topic.
    ///         Signature: keccak256("CallSettled(bytes16,bytes16,address,uint64,
    ///         uint64,uint64,uint8,bool,uint32,uint64)") — enum encodes as uint8.
    function test_CallSettled_ABI_Identity() public pure {
        bytes32 expected = keccak256(
            "CallSettled(bytes16,bytes16,address,uint64,uint64,uint64,uint8,bool,uint32,uint64)"
        );
        // IPactSettler.CallSettled uses SettlementStatus enum (encodes as uint8).
        bytes32 ipactSettlerTopic = IPactSettler.CallSettled.selector;
        // PactEvents.CallSettled uses uint8 directly.
        bytes32 pactEventsTopic = PactEvents.CallSettled.selector;

        assertEq(ipactSettlerTopic, expected, "IPactSettler.CallSettled topic0 mismatch");
        assertEq(pactEventsTopic,   expected, "PactEvents.CallSettled topic0 mismatch");
        assertEq(ipactSettlerTopic, pactEventsTopic, "topic0 divergence: not alias-true");
    }

    // -----------------------------------------------------------------------
    // WP-05 plan 05-02 — SET-11 (ProtocolPaused) + SET-12 (BatchTooLarge)
    // Ported from settle_batch.rs:99-115 (protocol-paused fast-revert) and
    // settle_batch.rs:132-135 (BatchTooLarge edge).
    // P3 OPTIMIZED-DIVERGENCE (05-GATE-A-DECISIONS.md P3): these tests cover
    // only the operationally-real authorized-settler paths. The unauthorized+
    // paused corner intentionally diverges (EVM returns
    // AccessControlUnauthorizedAccount there); that divergence is documented in
    // the WP-06 parity matrix — no test is written for it here.
    // -----------------------------------------------------------------------

    /// @notice settle_batch.rs:99-115 — authorized settler calling settleBatch
    ///         while protocolPaused reverts ProtocolPaused BEFORE any per-event
    ///         work or token transfer; agent + pool USDC balances unchanged.
    ///         Port of 05-settle-batch.test.ts:529.
    function test_ProtocolPaused_RejectsSettleBatch() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // Pause the protocol via the authority.
        vm.prank(authority);
        reg.pauseProtocol(true);

        // Snapshot balances before the attempted settle.
        uint256 agentBefore = usdc.balanceOf(agent);
        uint256 poolBefore  = usdc.balanceOf(address(pool));

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x5A, agent, SLUG, 1_000, 0, 50, false, 1, 1);

        vm.prank(settlerSigner);
        vm.expectRevert(ProtocolPaused.selector);
        settler.settleBatch(events);

        // No balances must have moved.
        assertEq(usdc.balanceOf(agent),        agentBefore, "agent balance must not change on ProtocolPaused");
        assertEq(usdc.balanceOf(address(pool)), poolBefore,  "pool balance must not change on ProtocolPaused");
    }

    /// @notice settle_batch.rs:99-115 resume path — pause -> revert; unpause ->
    ///         fresh callId settles successfully emitting CallSettled(Settled).
    ///         Port of 05-settle-batch.test.ts:595.
    function test_ProtocolPaused_ResumesAfterUnpause() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // Pause.
        vm.prank(authority);
        reg.pauseProtocol(true);

        // First attempt: different callId (0x5B) — must revert.
        IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
        ev1[0] = _makeEvent(0x5B, agent, SLUG, 1_000, 0, 50, false, 1, 1);
        vm.prank(settlerSigner);
        vm.expectRevert(ProtocolPaused.selector);
        settler.settleBatch(ev1);

        // Unpause.
        vm.prank(authority);
        reg.pauseProtocol(false);

        // Second attempt: fresh callId (0x5C) — must succeed.
        IPactSettler.SettlementEvent[] memory ev2 = new IPactSettler.SettlementEvent[](1);
        ev2[0] = _makeEvent(0x5C, agent, SLUG, 1_000, 0, 50, false, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev2[0].callId, SLUG, agent,
            1_000, 0, 0,
            IPactSettler.SettlementStatus.Settled,
            false, 50, ev2[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(ev2); // must NOT revert
    }

    /// @notice settle_batch.rs:132-135 — 51 events (> MAX_BATCH_SIZE=50) reverts
    ///         BatchTooLarge. Source-enforced invariant (D-LOCK-5, D-LOCK-BATCH).
    function test_BatchTooLarge_51EventsRevert() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // 51 events (strictly greater than MAX_BATCH_SIZE=50) -> BatchTooLarge.
        IPactSettler.SettlementEvent[] memory events =
            new IPactSettler.SettlementEvent[](51);
        for (uint8 i = 0; i < 51; i++) {
            events[i] = _makeEvent(i, agent, SLUG, 1_000, 0, 50, false, 1, 1);
        }
        vm.prank(settlerSigner);
        vm.expectRevert(BatchTooLarge.selector);
        settler.settleBatch(events);
    }

    /// @notice settle_batch.rs:132-135 boundary — exactly 50 events (==
    ///         MAX_BATCH_SIZE) must NOT revert (strictly-greater rule: 50 OK,
    ///         51 rejects). Regression guard for the boundary.
    function test_BatchTooLarge_50EventsAccepted() public {
        _register(SLUG);
        _fundPool(SLUG, 10_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 100_000_000, 100_000_000);

        // 50 events (== MAX_BATCH_SIZE) -> accepted.
        IPactSettler.SettlementEvent[] memory events =
            new IPactSettler.SettlementEvent[](50);
        for (uint8 i = 0; i < 50; i++) {
            events[i] = _makeEvent(i, agent, SLUG, 1_000, 0, 50, false, 1, 1);
        }
        vm.prank(settlerSigner);
        settler.settleBatch(events); // must NOT revert
    }

    // -----------------------------------------------------------------------
    // WP-05 plan 05-03 — SET-11 per-event EndpointPaused (D-LOCK-PREC slot)
    // Ports settle_batch.rs:209 — `if ep.paused != 0 -> EndpointPaused` —
    // inserted AFTER the DuplicateCallId dedup READ (:194) and BEFORE
    // RecipientCoverageMismatch (:213). Additive only; no WP-04 reorder.
    // -----------------------------------------------------------------------

    /// @notice settle_batch.rs:209 — endpoint paused per-event reverts
    ///         EndpointPaused (SET-11). Pause via registry authority; attempt
    ///         settleBatch; must revert EndpointPaused.selector.
    ///         RED: no per-event pause check exists yet — batch proceeds and
    ///         does NOT revert EndpointPaused.
    function test_EndpointPaused_RevertsPerEvent() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        vm.prank(authority);
        reg.pauseEndpoint(SLUG, true);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x60, agent, SLUG, 1_000, 0, 50, false, 1, 1);

        vm.prank(settlerSigner);
        vm.expectRevert(EndpointPaused.selector);
        settler.settleBatch(events);
    }

    /// @notice settle_batch.rs:209 resume path — pause endpoint then unpause;
    ///         settleBatch with a fresh callId must NOT revert.
    ///         RED: no per-event pause check yet — this test passes even when
    ///         paused (incorrect), so RED is confirmed by test_EndpointPaused_RevertsPerEvent.
    function test_EndpointPaused_CanResumeAfterUnpause() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        vm.prank(authority);
        reg.pauseEndpoint(SLUG, true);
        vm.prank(authority);
        reg.pauseEndpoint(SLUG, false);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x61, agent, SLUG, 1_000, 0, 50, false, 1, 1);

        vm.prank(settlerSigner);
        settler.settleBatch(events); // must NOT revert
    }

    /// @notice D-LOCK-PREC regression: dedup READ (:194) precedes EndpointPaused
    ///         (:209). Consume callId while endpoint is live; pause endpoint;
    ///         replay same callId -> must revert DuplicateCallId (NOT EndpointPaused).
    ///         Conditional RED: dedup READ already exists at :84, so this test
    ///         passes pre-impl (DuplicateCallId fires before any pause check).
    ///         It is the regression guard — must stay GREEN after impl too.
    function test_EndpointPaused_DedupReadPrecedesEndpointPaused() public {
        _register(SLUG);
        _fundPool(SLUG, 5_000_000);
        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // Consume callId while endpoint is live.
        IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
        ev1[0] = _makeEvent(0x62, agent, SLUG, 1_000, 0, 50, false, 1, 1);
        vm.prank(settlerSigner);
        settler.settleBatch(ev1);

        // Pause endpoint.
        vm.prank(authority);
        reg.pauseEndpoint(SLUG, true);

        // Replay same callId with endpoint paused -> DuplicateCallId (NOT EndpointPaused).
        // Proves dedup READ precedes EndpointPaused (D-LOCK-PREC).
        vm.prank(settlerSigner);
        vm.expectRevert(DuplicateCallId.selector);
        settler.settleBatch(ev1);
    }

    // -----------------------------------------------------------------------
    // WP-05 plan 05-04 -- SET-10 exposure-cap clamp (ExposureCapClamped)
    // Ports settle_batch.rs:400-408 (cap clamp inside recordCallAndCapAccrual)
    // and the captain-ratified P1 inference in _settleSuccess
    // (05-GATE-A-DECISIONS.md P1): payableRefund < intendedRefundAfterCap
    // => status = ExposureCapClamped, set BEFORE the pool-balance check so
    // a later PoolDepleted can overwrite it (D-LOCK-CLAMP-ORDER).
    // currentPeriodRefunds accrues the CLAMPED amount and is NOT rolled back.
    // -----------------------------------------------------------------------

    /// @notice settle_batch.rs:400-408 -- exposure cap clamps the refund to
    ///         cap_remaining; status becomes ExposureCapClamped (enum 3).
    ///         Port of 05-settle-batch.test.ts:485 and 07-exposure-cap.test.ts:25.
    ///         cap=1000, refund=5000, pool=5_000_000.
    ///         RED: cap clamp absent -> payableRefund=5000 (not clamped) AND
    ///         emit hardcodes Settled -> expectEmit ExposureCapClamped mismatches.
    function test_ExposureCapClamped_PartialActualRefund() public {
        // Register SLUG_C with a small exposureCapPerHour=1000.
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG_C, 500, 0, 5000, 1000, 1_000, false, 0, none);
        _fundPool(SLUG_C, 5_000_000);

        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // cap=1000, refund=5000 -> cap_remaining=1000, intended (5000) > cap_remaining
        // -> clamped to 1000, ExposureCapClamped.
        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x46, agent, SLUG_C, 1_000, 5_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            events[0].callId, SLUG_C, agent,
            1_000, 5_000, 1_000,
            IPactSettler.SettlementStatus.ExposureCapClamped,
            true, 6000, events[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Agent: paid 1000 premium, received 1000 (clamped) refund -> net 0.
        assertEq(usdc.balanceOf(agent), 10_000_000, "agent net must be 0 (premium == clamped refund)");
        // currentPeriodRefunds accrues the CLAMPED amount (not rolled back).
        assertEq(reg.getEndpoint(SLUG_C).currentPeriodRefunds, 1_000, "currentPeriodRefunds must accrue clamped amount");
    }

    /// @notice settle_batch.rs:400-408 cumulative: two batches exhaust the cap.
    ///         Port of 07-exposure-cap.test.ts:25. cap=1_000_000.
    ///         Batch 1: refund=600_000 -> full (Settled), currentPeriodRefunds=600_000.
    ///         Batch 2: refund=500_000, cap_remaining=400_000 -> clamped to 400_000
    ///         (ExposureCapClamped). currentPeriodRefunds after both == 1_000_000.
    ///         RED: no clamp -> batch 2 emits Settled with actualRefund=500_000;
    ///         expectEmit ExposureCapClamped mismatches.
    ///         Also covers adversarial vector 1 (GATE-A): saturatingSub boundary
    ///         currentPeriodRefunds >= exposureCap -> cap_remaining=0 -> clamp-to-0.
    function test_ExposureCap_CumulativeClampAcrossBatches() public {
        // Register SLUG_C with cap=1_000_000.
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG_C, 500, 0, 5000, 1000, 1_000_000, false, 0, none);
        _fundPool(SLUG_C, 5_000_000);

        address agent = makeAddr("agent");
        _provisionAgent(agent, 20_000_000, 20_000_000);

        // Batch 1: refund=600_000 < cap=1_000_000 -> full Settled.
        IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
        ev1[0] = _makeEvent(0x71, agent, SLUG_C, 1_000, 600_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev1[0].callId, SLUG_C, agent,
            1_000, 600_000, 600_000,
            IPactSettler.SettlementStatus.Settled,
            true, 6000, ev1[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(ev1);

        assertEq(reg.getEndpoint(SLUG_C).currentPeriodRefunds, 600_000, "currentPeriodRefunds after batch 1");

        // Batch 2: refund=500_000, cap_remaining=400_000 -> clamped to 400_000.
        IPactSettler.SettlementEvent[] memory ev2 = new IPactSettler.SettlementEvent[](1);
        ev2[0] = _makeEvent(0x72, agent, SLUG_C, 1_000, 500_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev2[0].callId, SLUG_C, agent,
            1_000, 500_000, 400_000,
            IPactSettler.SettlementStatus.ExposureCapClamped,
            true, 6000, ev2[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(ev2);

        // currentPeriodRefunds == 600_000 + 400_000 = 1_000_000 (cap exhausted, not rolled back).
        assertEq(reg.getEndpoint(SLUG_C).currentPeriodRefunds, 1_000_000, "currentPeriodRefunds must equal cap after both batches");

        // Adversarial vector 1 (GATE-A adversarial pass, saturatingSub boundary):
        // third batch when currentPeriodRefunds == exposureCap -> cap_remaining=0
        // -> everything clamps to 0 (ExposureCapClamped, actualRefund=0).
        IPactSettler.SettlementEvent[] memory ev3 = new IPactSettler.SettlementEvent[](1);
        ev3[0] = _makeEvent(0x73, agent, SLUG_C, 1_000, 100_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev3[0].callId, SLUG_C, agent,
            1_000, 100_000, 0,
            IPactSettler.SettlementStatus.ExposureCapClamped,
            true, 6000, ev3[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(ev3);

        // currentPeriodRefunds stays at cap (clamped-to-0 adds nothing, no rollback).
        assertEq(reg.getEndpoint(SLUG_C).currentPeriodRefunds, 1_000_000, "currentPeriodRefunds must not change on 0-clamp");
    }

    // -----------------------------------------------------------------------
    // WP-05 plan 05-05 — SET-09 pool-depleted clamp (PoolDepleted)
    // Ports settle_batch.rs:462-469 — fills the empty
    // `if (ps.currentBalance < payableRefund) {}` block in _settleSuccess.
    // D-LOCK-CLAMP-ORDER: PoolDepleted (set :468, AFTER :407) OVERWRITES
    // ExposureCapClamped when both fire. No currentPeriodRefunds rollback.
    // -----------------------------------------------------------------------

    /// @notice settle_batch.rs:462-469 — pool funded only 100, intended refund
    ///         200_000 (cap 5_000_000 -> no cap clamp). Pool (100) < payableRefund
    ///         (200_000) -> PoolDepleted (enum 2), actualRefund=0. Premium still
    ///         charged. Port of 05-settle-batch.test.ts:442.
    ///         RED: empty if leaves status as Settled (default); expectEmit
    ///         PoolDepleted mismatches.
    function test_PoolDepleted_RefundSkippedAndMarked() public {
        _register(SLUG);
        _fundPool(SLUG, 100);  // only 100 in pool -- far below refund 200_000

        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x3C, agent, SLUG, 1_000, 200_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            events[0].callId, SLUG, agent,
            1_000, 200_000, 0,
            IPactSettler.SettlementStatus.PoolDepleted,
            true, 6000, events[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // Agent paid premium, received no refund (pool could not cover).
        assertEq(usdc.balanceOf(agent), 10_000_000 - 1_000, "agent must pay premium; no refund on PoolDepleted");
    }

    /// @notice D-LOCK-CLAMP-ORDER precedence: small cap clamps refund (sets
    ///         ExposureCapClamped), then pool (100) < clamped amount (1000) ->
    ///         PoolDepleted OVERWRITES ExposureCapClamped (final status = 2).
    ///         currentPeriodRefunds == clamped amount (1000), NOT rolled back
    ///         (P1(b) no-rollback -- Solana :409-414 accrual is unconditional
    ///         within the cap block; pool check fires later).
    ///         totalRefunds UNCHANGED (recordRefundPaid NOT called; actualRefund=0).
    ///         RED: empty if leaves status as ExposureCapClamped (set by 05-04
    ///         inference); expectEmit PoolDepleted mismatches.
    function test_PoolDepleted_OverwritesExposureCapClamped() public {
        // Register SLUG_B with small exposureCapPerHour=1000 and no fee
        // override (uses protocol default Treasury 10% -> 1 recipient).
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG_B, 500, 0, 5000, 1000, 1_000, false, 0, none);
        // Fund pool with only 100 -- below the clamped cap (1000).
        _fundPool(SLUG_B, 100);

        address agent = makeAddr("agent");
        _provisionAgent(agent, 10_000_000, 10_000_000);

        // refund=5000 > cap=1000 -> cap clamps to 1000 (ExposureCapClamped inferred).
        // Then pool (100) < clamped (1000) -> PoolDepleted fires and OVERWRITES.
        IPactSettler.SettlementEvent[] memory events = new IPactSettler.SettlementEvent[](1);
        events[0] = _makeEvent(0x3D, agent, SLUG_B, 1_000, 5_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            events[0].callId, SLUG_B, agent,
            1_000, 5_000, 0,
            IPactSettler.SettlementStatus.PoolDepleted,
            true, 6000, events[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(events);

        // currentPeriodRefunds == clamped amount (1000) -- accrued by
        // recordCallAndCapAccrual, NOT rolled back on PoolDepleted.
        assertEq(
            reg.getEndpoint(SLUG_B).currentPeriodRefunds,
            1_000,
            "currentPeriodRefunds must equal clamped amount (no rollback on PoolDepleted)"
        );
        // totalRefunds UNCHANGED (recordRefundPaid not called; actualRefund=0).
        assertEq(
            reg.getEndpoint(SLUG_B).totalRefunds,
            0,
            "totalRefunds must be 0 (recordRefundPaid skipped on PoolDepleted)"
        );
        // Agent paid premium only -- no refund.
        assertEq(usdc.balanceOf(agent), 10_000_000 - 1_000, "agent pays premium only on PoolDepleted");
    }

    /// @notice settle_batch.rs:396-399 period reset asserted end-to-end through
    ///         settleBatch after WP-05 cap clamp is live. Port of
    ///         07-exposure-cap.test.ts:81. cap=500_000. Batch 1: full 500_000
    ///         used. vm.warp(currentPeriodStart + 3601). Batch 2: 500_000 again
    ///         -> period reset fires inside recordCallAndCapAccrual -> Settled.
    ///         Does NOT re-implement the period reset (already WP-04).
    ///         RED: the reset path itself always passes; RED is confirmed by
    ///         test_ExposureCapClamped_PartialActualRefund for the clamp predicate.
    function test_ExposureCap_ResetsAfter1Hour() public {
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG_C, 500, 0, 5000, 1000, 500_000, false, 0, none);
        _fundPool(SLUG_C, 5_000_000);

        address agent = makeAddr("agent");
        _provisionAgent(agent, 20_000_000, 20_000_000);

        // Batch 1: refund=500_000 == cap -> NOT clamped (strict >), Settled.
        // currentPeriodRefunds = 500_000 (cap exhausted).
        IPactSettler.SettlementEvent[] memory ev1 = new IPactSettler.SettlementEvent[](1);
        ev1[0] = _makeEvent(0x81, agent, SLUG_C, 1_000, 500_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev1[0].callId, SLUG_C, agent,
            1_000, 500_000, 500_000,
            IPactSettler.SettlementStatus.Settled,
            true, 6000, ev1[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(ev1);

        assertEq(reg.getEndpoint(SLUG_C).currentPeriodRefunds, 500_000, "currentPeriodRefunds after batch 1");

        // Warp > 3600 s past the stored period start to trigger the period reset.
        uint64 storedStart = reg.getEndpoint(SLUG_C).currentPeriodStart;
        vm.warp(uint256(storedStart) + 3601);

        // Batch 2: refund=500_000 again. Period reset fires (currentPeriodRefunds=0,
        // cap_remaining=500_000) -> not clamped -> Settled, full 500_000.
        IPactSettler.SettlementEvent[] memory ev2 = new IPactSettler.SettlementEvent[](1);
        ev2[0] = _makeEvent(0x82, agent, SLUG_C, 1_000, 500_000, 6000, true, 1, 1);

        vm.expectEmit(true, true, true, true);
        emit IPactSettler.CallSettled(
            ev2[0].callId, SLUG_C, agent,
            1_000, 500_000, 500_000,
            IPactSettler.SettlementStatus.Settled,
            true, 6000, ev2[0].timestamp
        );
        vm.prank(settlerSigner);
        settler.settleBatch(ev2);

        // Both refunds credited: -2000 premium + 1_000_000 refund.
        assertEq(usdc.balanceOf(agent), 20_000_000 - 2_000 + 1_000_000, "agent must receive both full refunds after reset");
        // currentPeriodRefunds = 500_000 (new period, only batch 2 accrued).
        assertEq(reg.getEndpoint(SLUG_C).currentPeriodRefunds, 500_000, "currentPeriodRefunds after reset must be batch-2 amount only");
    }
}
