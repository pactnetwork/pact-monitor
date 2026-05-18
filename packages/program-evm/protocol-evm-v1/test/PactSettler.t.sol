// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PactSettler} from "../src/PactSettler.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {IPactSettler} from "../src/interfaces/IPactSettler.sol";
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
}
