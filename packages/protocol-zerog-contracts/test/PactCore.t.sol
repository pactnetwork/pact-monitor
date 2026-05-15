// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2}      from "forge-std/Test.sol";
import {IERC20}              from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PactCore}            from "../src/PactCore.sol";
import {MockUsdc}            from "../src/MockUsdc.sol";
import {MockUsdcFaucet}      from "../src/MockUsdcFaucet.sol";

/// @title  PactCore — Foundry suite porting v1 LiteSVM scenarios T1–T26.
/// @notice See plan §"Test scenarios to port" + Round-2 review T22–T26.
contract PactCoreTest is Test {
    PactCore  pact;
    MockUsdc  usdc;

    address admin     = makeAddr("admin");
    address settler   = makeAddr("settler");
    address treasury  = makeAddr("treasury");
    address affiliate = makeAddr("affiliate");
    address agent     = makeAddr("agent");

    bytes16 constant SLUG_A = bytes16("helius          ");
    bytes16 constant SLUG_B = bytes16("birdeye         ");

    function setUp() public {
        usdc = new MockUsdc(address(this));
        pact = new PactCore(admin, settler, treasury, IERC20(address(usdc)));

        // give agent plenty of mUSDC + ∞ allowance
        usdc.mint(agent, 1_000_000e6);
        vm.prank(agent);
        usdc.approve(address(pact), type(uint256).max);
    }

    // ───────────────────────────────────────────────────────────────────
    // Helpers
    // ───────────────────────────────────────────────────────────────────

    function _defaultConfig() internal pure returns (PactCore.EndpointConfig memory cfg) {
        cfg.agentTokenId       = 42;
        cfg.flatPremium        = 1_000;     // 0.001 mUSDC
        cfg.percentBps         = 0;
        cfg.imputedCost        = 0;
        cfg.latencySloMs       = 5_000;
        cfg.exposureCapPerHour = 0;          // disabled by default
        // counters/window left at zero
        cfg.paused             = false;
        cfg.exists             = false;      // set true inside registerEndpoint
    }

    function _twoRecipients(uint16 treasuryBps, uint16 affBps)
        internal view returns (PactCore.FeeRecipient[] memory rs)
    {
        rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient({
            kind:        PactCore.RecipientKind.Treasury,
            destination: treasury,
            bps:         treasuryBps
        });
        rs[1] = PactCore.FeeRecipient({
            kind:        PactCore.RecipientKind.Affiliate,
            destination: affiliate,
            bps:         affBps
        });
    }

    function _register(bytes16 slug, PactCore.EndpointConfig memory cfg, PactCore.FeeRecipient[] memory rs)
        internal
    {
        vm.prank(admin);
        pact.registerEndpoint(slug, cfg, rs);
    }

    function _registerDefault(bytes16 slug) internal {
        _register(slug, _defaultConfig(), _twoRecipients(1_000, 500)); // 10% + 5% = 15% total
    }

    function _topUp(bytes16 slug, uint128 amount) internal {
        // Fund the topUp caller (this contract) and approve
        usdc.mint(address(this), amount);
        usdc.approve(address(pact), amount);
        pact.topUpCoveragePool(slug, amount);
    }

    function _mkRecord(
        bytes16 callId,
        bytes16 slug,
        bool    breach,
        uint96  premium,
        uint96  refund
    ) internal view returns (PactCore.SettlementRecord memory r) {
        r = PactCore.SettlementRecord({
            callId:    callId,
            slug:      slug,
            agent:     agent,
            breach:    breach,
            premiumWei: premium,
            refundWei:  refund,
            timestamp:  uint64(block.timestamp),
            rootHash:   bytes32(uint256(uint128(uint256(keccak256(abi.encode(callId))))))
        });
    }

    function _settle(PactCore.SettlementRecord memory r) internal {
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = r;
        vm.prank(settler);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T1 — non-breach call: premium debited, pool grows by (premium − Σ cuts)
    // ───────────────────────────────────────────────────────────────────
    function test_T1_settleNonBreach() public {
        _registerDefault(SLUG_A);

        uint96 premium = 10_000;
        uint256 expectedTreasury  = (uint256(premium) * 1_000) / 10_000;
        uint256 expectedAffiliate = (uint256(premium) * 500)   / 10_000;
        uint256 expectedPoolDelta = premium - expectedTreasury - expectedAffiliate;

        _settle(_mkRecord(bytes16("c1"), SLUG_A, false, premium, 0));

        (uint128 balance, uint128 totalDeposits) = pact.coveragePool(SLUG_A);
        assertEq(balance, expectedPoolDelta, "pool grew by net premium");
        assertEq(totalDeposits, 0,           "no topup happened");
        assertEq(usdc.balanceOf(treasury),  expectedTreasury,  "treasury cut");
        assertEq(usdc.balanceOf(affiliate), expectedAffiliate, "affiliate cut");

        // status = Settled (1)
        assertEq(pact.callStatus(bytes16("c1")), 1);

        // endpoint stats (struct has 15 fields; totalCalls is index 8)
        (, , , , , , , , uint64 totalCalls, uint64 totalBreaches, uint96 totalPremiums, , , , ) =
            pact.endpointConfig(SLUG_A);
        assertEq(totalCalls,     1);
        assertEq(totalBreaches,  0);
        assertEq(totalPremiums,  premium);
    }

    // ───────────────────────────────────────────────────────────────────
    // T2 — breach call, full pool, no exposure cap: refund == requested, Settled
    // ───────────────────────────────────────────────────────────────────
    function test_T2_breachFullPoolStatusSettled() public {
        _registerDefault(SLUG_A);
        _topUp(SLUG_A, 100_000); // plenty

        uint96 premium = 10_000;
        uint96 refund  = 5_000;
        _settle(_mkRecord(bytes16("c2"), SLUG_A, true, premium, refund));

        // status Settled (1) — there is no `Refunded` enum
        assertEq(pact.callStatus(bytes16("c2")), 1);
        assertEq(usdc.balanceOf(agent), 1_000_000e6 - premium + refund, "agent refunded");

        (, , , , , , , , uint64 totalCalls, uint64 totalBreaches, , , , , ) =
            pact.endpointConfig(SLUG_A);
        assertEq(totalCalls,    1);
        assertEq(totalBreaches, 1);
    }

    // ───────────────────────────────────────────────────────────────────
    // T3 — breach call, partial pool: clamped + PoolDepleted.
    // NB: premium debit grows pool by (premium − Σ cuts) BEFORE the refund
    // clamp, so the engineered case must have refund > (topup + net premium).
    // ───────────────────────────────────────────────────────────────────
    function test_T3_breachPoolDepleted() public {
        _registerDefault(SLUG_A);
        // no topup at all — pool starts empty, premium adds 8500, refund 50000 forces clamp.

        uint96 premium = 10_000;          // net to pool = 8500
        uint96 refund  = 50_000;          // way over pool

        _settle(_mkRecord(bytes16("c3"), SLUG_A, true, premium, refund));

        assertEq(pact.callStatus(bytes16("c3")), 3, "PoolDepleted");
        (uint128 balance, ) = pact.coveragePool(SLUG_A);
        assertEq(balance, 0, "pool drained");
    }

    // ───────────────────────────────────────────────────────────────────
    // T4 — breach hits exposure cap (clamps refund, not premium)
    // ───────────────────────────────────────────────────────────────────
    function test_T4_exposureCapClampsRefund() public {
        PactCore.EndpointConfig memory cfg = _defaultConfig();
        cfg.exposureCapPerHour = 3_000;   // tight cap
        _register(SLUG_A, cfg, _twoRecipients(1_000, 500));
        _topUp(SLUG_A, 100_000);

        uint96 premium = 10_000;
        uint96 refund  = 8_000;           // > cap

        _settle(_mkRecord(bytes16("c4"), SLUG_A, true, premium, refund));

        // status ExposureCapClamped (4)
        assertEq(pact.callStatus(bytes16("c4")), 4);
        // Agent receives only `cap` (3_000), pays premium in full.
        assertEq(usdc.balanceOf(agent), 1_000_000e6 - premium + 3_000);
    }

    // ───────────────────────────────────────────────────────────────────
    // T5 — duplicate callId reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T5_duplicateCallIdReverts() public {
        _registerDefault(SLUG_A);

        bytes16 id = bytes16("dup");
        _settle(_mkRecord(id, SLUG_A, false, 10_000, 0));

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = _mkRecord(id, SLUG_A, false, 10_000, 0);
        vm.prank(settler);
        vm.expectRevert(PactCore.DuplicateCallId.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T6 — batch > MAX_BATCH_SIZE reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T6_batchTooLargeReverts() public {
        _registerDefault(SLUG_A);
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](51);
        for (uint256 i = 0; i < 51; ++i) {
            batch[i] = _mkRecord(bytes16(uint128(i + 1)), SLUG_A, false, 10_000, 0);
        }
        vm.prank(settler);
        vm.expectRevert(PactCore.BatchTooLarge.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T7 — bps sum > 3000 reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T7_bpsSumExceedsCapReverts() public {
        PactCore.FeeRecipient[] memory rs = _twoRecipients(2_500, 1_000); // 35%
        vm.prank(admin);
        vm.expectRevert(PactCore.BpsSumExceedsCap.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // ───────────────────────────────────────────────────────────────────
    // T8 — two Treasury recipients reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T8_twoTreasuryReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury,  500);
        rs[1] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, affiliate, 500);
        vm.prank(admin);
        vm.expectRevert(PactCore.TreasuryCardinalityViolation.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // ───────────────────────────────────────────────────────────────────
    // T9 — duplicate destination reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T9_duplicateDestinationReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury,  treasury, 500);
        rs[1] = PactCore.FeeRecipient(PactCore.RecipientKind.Affiliate, treasury, 500); // dup
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidFeeRecipients.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // ───────────────────────────────────────────────────────────────────
    // T10 — non-settler caller reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T10_nonSettlerReverts() public {
        _registerDefault(SLUG_A);
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = _mkRecord(bytes16("nope"), SLUG_A, false, 10_000, 0);
        vm.expectRevert(PactCore.Unauthorized.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T11 — reentrancy via malicious ERC20: a token that, on `transfer`,
    //       calls back into PactCore.settleBatch. The `nonReentrant`
    //       modifier on settleBatch reverts the inner call, which bubbles
    //       and reverts the outer batch. This is the documented DoS surface
    //       a malicious recipient creates — pull-pattern would fix it but is
    //       deferred to v2.
    // ───────────────────────────────────────────────────────────────────
    function test_T11_reentrantTokenRevertsBatch() public {
        // Fresh PactCore + ReentrantToken stack
        ReentrantToken evil = new ReentrantToken();
        PactCore badPact = new PactCore(admin, settler, treasury, IERC20(address(evil)));
        evil.setTarget(badPact);

        // Mint to agent + approve
        evil.mint(agent, 1_000_000);
        vm.prank(agent);
        evil.approve(address(badPact), type(uint256).max);

        // Register endpoint where treasury is the evil token's target trigger
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](1);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury, 1_000);
        vm.prank(admin);
        badPact.registerEndpoint(SLUG_A, _defaultConfig(), rs);

        // Arm the trigger so transfer() reenters
        evil.arm();

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = PactCore.SettlementRecord({
            callId:    bytes16("re"),
            slug:      SLUG_A,
            agent:     agent,
            breach:    false,
            premiumWei: 10_000,
            refundWei:  0,
            timestamp:  uint64(block.timestamp),
            rootHash:   bytes32(uint256(7))
        });
        vm.prank(settler);
        vm.expectRevert(); // ReentrancyGuardReentrantCall (OZ v5) bubbles up
        badPact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T12 — protocol paused blocks all settles
    // ───────────────────────────────────────────────────────────────────
    function test_T12_protocolPausedReverts() public {
        _registerDefault(SLUG_A);
        vm.prank(admin);
        pact.pauseProtocol(true);

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = _mkRecord(bytes16("p1"), SLUG_A, false, 10_000, 0);
        vm.prank(settler);
        vm.expectRevert(PactCore.ProtocolIsPaused.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T13 — endpoint paused: mixed-batch reverts on first paused record
    //       (v1 behavior: revert on first failure)
    // ───────────────────────────────────────────────────────────────────
    function test_T13_endpointPausedReverts() public {
        _registerDefault(SLUG_A);
        _registerDefault(SLUG_B);
        vm.prank(admin);
        pact.pauseEndpoint(SLUG_A, true);

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](2);
        batch[0] = _mkRecord(bytes16("p2a"), SLUG_A, false, 10_000, 0);
        batch[1] = _mkRecord(bytes16("p2b"), SLUG_B, false, 10_000, 0);
        vm.prank(settler);
        vm.expectRevert(PactCore.EndpointIsPaused.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T14 — gas snapshot at MAX_BATCH_SIZE = 50 with 8 recipients
    // ───────────────────────────────────────────────────────────────────
    function test_T14_gasSnapshotMaxBatch() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](8);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury, 1_000);
        for (uint256 i = 1; i < 8; ++i) {
            rs[i] = PactCore.FeeRecipient(
                PactCore.RecipientKind.Affiliate,
                makeAddr(string(abi.encodePacked("aff", vm.toString(i)))),
                250
            );
        }
        _register(SLUG_A, _defaultConfig(), rs);

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](50);
        for (uint256 i = 0; i < 50; ++i) {
            batch[i] = _mkRecord(bytes16(uint128(i + 1)), SLUG_A, false, 10_000, 0);
        }

        vm.prank(settler);
        uint256 g0 = gasleft();
        pact.settleBatch(batch);
        uint256 used = g0 - gasleft();
        console2.log("T14 settleBatch(50, 8 recipients) gas:", used);
        // Sanity: well under 28M (plan's headroom). Adjust if it surprises us.
        assertLt(used, 28_000_000, "MAX_BATCH_SIZE budget exceeded");
    }

    // ───────────────────────────────────────────────────────────────────
    // T15 — slug bytes outside 0x20..0x7E reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T15_invalidSlugReverts() public {
        // 0x7F is just outside the printable range 0x20..0x7E. Use 16 bytes.
        bytes16 bad = bytes16(hex"7F000000000000000000000000000000");
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidSlug.selector);
        pact.registerEndpoint(bad, _defaultConfig(), _twoRecipients(1_000, 500));
    }

    // ───────────────────────────────────────────────────────────────────
    // T16 — Treasury bps == 0 reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T16_treasuryBpsZeroReverts() public {
        PactCore.FeeRecipient[] memory rs = _twoRecipients(0, 500);
        vm.prank(admin);
        vm.expectRevert(PactCore.TreasuryBpsZero.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // ───────────────────────────────────────────────────────────────────
    // T17 — re-register existing slug reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T17_reRegisterReverts() public {
        _registerDefault(SLUG_A);
        vm.prank(admin);
        vm.expectRevert(PactCore.EndpointAlreadyExists.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), _twoRecipients(1_000, 500));
    }

    // ───────────────────────────────────────────────────────────────────
    // T18 — updateEndpointConfig persists exposureCapPerHour = 0
    // ───────────────────────────────────────────────────────────────────
    function test_T18_updateConfigPersistsZero() public {
        PactCore.EndpointConfig memory cfg = _defaultConfig();
        cfg.exposureCapPerHour = 5_000;
        _register(SLUG_A, cfg, _twoRecipients(1_000, 500));

        PactCore.EndpointConfigUpdate memory upd;
        upd.setExposureCapPerHour = true;
        upd.exposureCapPerHour    = 0;

        vm.prank(admin);
        pact.updateEndpointConfig(SLUG_A, upd);

        // Position of exposureCapPerHour in the auto-generated getter:
        // (agentTokenId, flatPremium, percentBps, imputedCost, latencySloMs,
        //  exposureCapPerHour, currentPeriodStart, currentPeriodRefunds,
        //  totalCalls, totalBreaches, totalPremiums, totalRefunds, lastUpdated,
        //  paused, exists)
        (, , , , , uint96 ecCap, , , , , , , , , ) = pact.endpointConfig(SLUG_A);
        assertEq(ecCap, 0, "exposureCap actually persisted as 0");
    }

    // ───────────────────────────────────────────────────────────────────
    // T19 — missing approval → DelegateFailed (batch continues)
    // ───────────────────────────────────────────────────────────────────
    function test_T19_delegateFailedContinues() public {
        _registerDefault(SLUG_A);

        // unapproved agent
        address poor = makeAddr("poor");
        usdc.mint(poor, 1_000_000);
        // intentionally NO approve

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](2);
        batch[0] = PactCore.SettlementRecord({
            callId:    bytes16("df1"),
            slug:      SLUG_A,
            agent:     poor,
            breach:    false,
            premiumWei: 10_000,
            refundWei:  0,
            timestamp:  uint64(block.timestamp),
            rootHash:   bytes32(uint256(1))
        });
        batch[1] = _mkRecord(bytes16("df2"), SLUG_A, false, 10_000, 0);  // approved agent
        vm.prank(settler);
        pact.settleBatch(batch);

        // df1 stamped DelegateFailed (2); df2 settled normally (1)
        assertEq(pact.callStatus(bytes16("df1")), 2, "DelegateFailed");
        assertEq(pact.callStatus(bytes16("df2")), 1, "next record settled");
        assertEq(usdc.balanceOf(poor), 1_000_000, "no premium taken from poor");
    }

    // ───────────────────────────────────────────────────────────────────
    // T20 — future timestamp reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T20_futureTimestampReverts() public {
        _registerDefault(SLUG_A);
        PactCore.SettlementRecord memory r = _mkRecord(bytes16("ts"), SLUG_A, false, 10_000, 0);
        r.timestamp = uint64(block.timestamp + 1);
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = r;
        vm.prank(settler);
        vm.expectRevert(PactCore.InvalidTimestamp.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T21 — premium < MIN_PREMIUM reverts
    // ───────────────────────────────────────────────────────────────────
    function test_T21_premiumTooSmallReverts() public {
        _registerDefault(SLUG_A);
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = _mkRecord(bytes16("ps"), SLUG_A, false, 99, 0); // below MIN_PREMIUM=100
        vm.prank(settler);
        vm.expectRevert(PactCore.PremiumTooSmall.selector);
        pact.settleBatch(batch);
    }

    // ───────────────────────────────────────────────────────────────────
    // T22 — empty batch no-op
    // ───────────────────────────────────────────────────────────────────
    function test_T22_emptyBatchNoOp() public {
        _registerDefault(SLUG_A);
        PactCore.SettlementRecord[] memory empty = new PactCore.SettlementRecord[](0);
        vm.prank(settler);
        pact.settleBatch(empty);
        (uint128 balance, ) = pact.coveragePool(SLUG_A);
        assertEq(balance, 0);
    }

    // ───────────────────────────────────────────────────────────────────
    // T23 — recipientEarnings accumulator across multiple records in one batch
    // ───────────────────────────────────────────────────────────────────
    function test_T23_earningsAccumulator() public {
        _registerDefault(SLUG_A);

        uint96 premium = 10_000;
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](2);
        batch[0] = _mkRecord(bytes16("e1"), SLUG_A, false, premium, 0);
        batch[1] = _mkRecord(bytes16("e2"), SLUG_A, false, premium, 0);
        vm.prank(settler);
        pact.settleBatch(batch);

        // Treasury at 10% of 10000 = 1000 per record; total = 2000
        assertEq(pact.recipientEarnings(SLUG_A, treasury),  2 * 1_000);
        assertEq(pact.recipientEarnings(SLUG_A, affiliate), 2 * 500);
    }

    // ───────────────────────────────────────────────────────────────────
    // T24 — topUpCoveragePool to a paused endpoint succeeds (v1)
    // ───────────────────────────────────────────────────────────────────
    function test_T24_topUpWorksWhilePaused() public {
        _registerDefault(SLUG_A);
        vm.prank(admin);
        pact.pauseEndpoint(SLUG_A, true);

        _topUp(SLUG_A, 5_000);
        (uint128 balance, uint128 totalDeposits) = pact.coveragePool(SLUG_A);
        assertEq(balance,       5_000);
        assertEq(totalDeposits, 5_000);
    }

    // ───────────────────────────────────────────────────────────────────
    // T25 — gas snapshot at min batch (1 record, 8 recipients)
    // ───────────────────────────────────────────────────────────────────
    function test_T25_gasSnapshotMinBatch() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](8);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury, 1_000);
        for (uint256 i = 1; i < 8; ++i) {
            rs[i] = PactCore.FeeRecipient(
                PactCore.RecipientKind.Affiliate,
                makeAddr(string(abi.encodePacked("aff", vm.toString(i)))),
                250
            );
        }
        _register(SLUG_A, _defaultConfig(), rs);

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = _mkRecord(bytes16("g1"), SLUG_A, false, 10_000, 0);

        vm.prank(settler);
        uint256 g0 = gasleft();
        pact.settleBatch(batch);
        uint256 used = g0 - gasleft();
        console2.log("T25 settleBatch(1, 8 recipients) gas:", used);
    }

    // ───────────────────────────────────────────────────────────────────
    // T26 — slug round-trip: NUL in middle OK; high bit fails
    // ───────────────────────────────────────────────────────────────────
    function test_T26a_slugWithMiddleNul() public {
        bytes16 mixed = bytes16(hex"68656c6c6f00776f726c640000000000"); // "hello\0world"
        _register(mixed, _defaultConfig(), _twoRecipients(1_000, 500));
        (, , , , , , , , , , , , , , bool exists) = pact.endpointConfig(mixed);
        assertTrue(exists);
    }

    function test_T26b_slugWith0x7FFails() public {
        bytes16 bad = bytes16(hex"7F000000000000000000000000000000"); // 16 bytes; 0x7F invalid
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidSlug.selector);
        pact.registerEndpoint(bad, _defaultConfig(), _twoRecipients(1_000, 500));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Coverage tests — auth failures + validator edge cases + exposure-cap
    // window/disable paths + DelegateFailed via returns(false) + Faucet/MockUsdc
    // ─────────────────────────────────────────────────────────────────────

    // C1 — registerEndpoint as non-admin reverts
    function test_C1_registerNonAdminReverts() public {
        vm.expectRevert(PactCore.Unauthorized.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), _twoRecipients(1_000, 500));
    }

    // C2 — updateEndpointConfig: non-admin + non-existent slug
    function test_C2a_updateConfigNonAdminReverts() public {
        PactCore.EndpointConfigUpdate memory upd;
        vm.expectRevert(PactCore.Unauthorized.selector);
        pact.updateEndpointConfig(SLUG_A, upd);
    }
    function test_C2b_updateConfigEndpointNotFoundReverts() public {
        PactCore.EndpointConfigUpdate memory upd;
        vm.prank(admin);
        vm.expectRevert(PactCore.EndpointNotFound.selector);
        pact.updateEndpointConfig(SLUG_A, upd);
    }

    // C3 — updateFeeRecipients happy path + auth + not-found
    function test_C3a_updateFeeRecipientsHappy() public {
        _registerDefault(SLUG_A);
        PactCore.FeeRecipient[] memory rs = _twoRecipients(2_000, 1_000);
        vm.prank(admin);
        pact.updateFeeRecipients(SLUG_A, rs);
        (PactCore.RecipientKind k0, address d0, uint16 b0) = pact.feeRecipients(SLUG_A, 0);
        assertEq(uint256(k0), uint256(PactCore.RecipientKind.Treasury));
        assertEq(d0, treasury);
        assertEq(b0, 2_000);
    }
    function test_C3b_updateFeeRecipientsNonAdminReverts() public {
        _registerDefault(SLUG_A);
        vm.expectRevert(PactCore.Unauthorized.selector);
        pact.updateFeeRecipients(SLUG_A, _twoRecipients(1_000, 500));
    }
    function test_C3c_updateFeeRecipientsNotFoundReverts() public {
        vm.prank(admin);
        vm.expectRevert(PactCore.EndpointNotFound.selector);
        pact.updateFeeRecipients(SLUG_A, _twoRecipients(1_000, 500));
    }

    // C4 — pauseEndpoint: auth + not-found
    function test_C4a_pauseEndpointNonAdminReverts() public {
        vm.expectRevert(PactCore.Unauthorized.selector);
        pact.pauseEndpoint(SLUG_A, true);
    }
    function test_C4b_pauseEndpointNotFoundReverts() public {
        vm.prank(admin);
        vm.expectRevert(PactCore.EndpointNotFound.selector);
        pact.pauseEndpoint(SLUG_A, true);
    }

    // C5 — pauseProtocol non-admin reverts
    function test_C5_pauseProtocolNonAdminReverts() public {
        vm.expectRevert(PactCore.Unauthorized.selector);
        pact.pauseProtocol(true);
    }

    // C6 — topUpCoveragePool to non-existent slug reverts
    function test_C6_topUpNotFoundReverts() public {
        usdc.mint(address(this), 1_000);
        usdc.approve(address(pact), 1_000);
        vm.expectRevert(PactCore.EndpointNotFound.selector);
        pact.topUpCoveragePool(SLUG_A, 1_000);
    }

    // C7 — settleBatch with non-existent slug reverts
    function test_C7_settleEndpointNotFoundReverts() public {
        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = _mkRecord(bytes16("x"), SLUG_A, false, 10_000, 0);
        vm.prank(settler);
        vm.expectRevert(PactCore.EndpointNotFound.selector);
        pact.settleBatch(batch);
    }

    // C8 — _validateFeeRecipients: address(0) destination, per-entry bps cap,
    //      length zero, length > MAX_FEE_RECIPIENTS
    function test_C8a_zeroDestinationReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, address(0), 500);
        rs[1] = PactCore.FeeRecipient(PactCore.RecipientKind.Affiliate, affiliate, 500);
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidFeeRecipients.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }
    function test_C8b_perEntryBpsCapReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury, 10_001);
        rs[1] = PactCore.FeeRecipient(PactCore.RecipientKind.Affiliate, affiliate, 100);
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidFeeRecipients.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }
    function test_C8c_emptyRecipientsReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](0);
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidFeeRecipients.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }
    function test_C8d_tooManyRecipientsReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](9);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury, 100);
        for (uint256 i = 1; i < 9; ++i) {
            rs[i] = PactCore.FeeRecipient(
                PactCore.RecipientKind.Affiliate,
                makeAddr(string(abi.encodePacked("a", vm.toString(i)))),
                100
            );
        }
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidFeeRecipients.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // C9 — exposure cap disabled (cap == 0) → pass-through, no clamp
    function test_C9_exposureCapDisabledPassThrough() public {
        _registerDefault(SLUG_A);          // cfg.exposureCapPerHour = 0
        _topUp(SLUG_A, 100_000);
        _settle(_mkRecord(bytes16("ec0"), SLUG_A, true, 10_000, 5_000));
        assertEq(pact.callStatus(bytes16("ec0")), 1, "Settled, no clamp");
        assertEq(usdc.balanceOf(agent), 1_000_000e6 - 10_000 + 5_000);
    }

    // C10 — exposure cap window resets after 3600s
    function test_C10_exposureCapWindowReset() public {
        PactCore.EndpointConfig memory cfg = _defaultConfig();
        cfg.exposureCapPerHour = 5_000;
        _register(SLUG_A, cfg, _twoRecipients(1_000, 500));
        _topUp(SLUG_A, 100_000);

        // Burn the full cap in the first record
        _settle(_mkRecord(bytes16("w1"), SLUG_A, true, 10_000, 6_000));
        // status ExposureCapClamped (4)
        assertEq(pact.callStatus(bytes16("w1")), 4);

        // Warp past 3600s — window resets, full refund available
        vm.warp(block.timestamp + 3601);
        _settle(_mkRecord(bytes16("w2"), SLUG_A, true, 10_000, 4_000));
        // refund 4000 ≤ 5000 cap (window reset) → status Settled (1)
        assertEq(pact.callStatus(bytes16("w2")), 1, "window reset, no clamp");
    }

    // C11 — exposure cap fully consumed → next refund capped=0 → status
    //       ExposureCapClamped but actualRefund=0; NO PoolDepleted flip
    function test_C11_exposureCapZeroAllowable() public {
        PactCore.EndpointConfig memory cfg = _defaultConfig();
        cfg.exposureCapPerHour = 5_000;
        _register(SLUG_A, cfg, _twoRecipients(1_000, 500));
        _topUp(SLUG_A, 100_000);

        // Burn the full cap
        _settle(_mkRecord(bytes16("z1"), SLUG_A, true, 10_000, 5_000));
        // Second breach attempt within the same window — allowable = 0
        _settle(_mkRecord(bytes16("z2"), SLUG_A, true, 10_000, 1_000));
        // Per B2: capped==0 → no PoolDepleted flip → status stays ExposureCapClamped (4)
        assertEq(pact.callStatus(bytes16("z2")), 4);
    }

    // C12 — DelegateFailed via returns(false) (vs revert)
    function test_C12_delegateFailedReturnsFalse() public {
        FalseReturningToken evil = new FalseReturningToken();
        PactCore badPact = new PactCore(admin, settler, treasury, IERC20(address(evil)));
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](1);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury, treasury, 1_000);
        vm.prank(admin);
        badPact.registerEndpoint(SLUG_A, _defaultConfig(), rs);

        PactCore.SettlementRecord[] memory batch = new PactCore.SettlementRecord[](1);
        batch[0] = PactCore.SettlementRecord({
            callId:    bytes16("rf"),
            slug:      SLUG_A,
            agent:     agent,
            breach:    false,
            premiumWei: 10_000,
            refundWei:  0,
            timestamp:  uint64(block.timestamp),
            rootHash:   bytes32(uint256(8))
        });
        vm.prank(settler);
        badPact.settleBatch(batch);
        // returns(false) → ok=false → DelegateFailed (2)
        assertEq(badPact.callStatus(bytes16("rf")), 2);
    }

    // C13 — MockUsdc onlyOwner restricts mint
    function test_C13_mockUsdcMintOnlyOwner() public {
        MockUsdc t = new MockUsdc(admin);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        t.mint(agent, 1);
    }

    // C15 — _validateFeeRecipients: zero Treasury recipients reverts
    function test_C15_zeroTreasuryReverts() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Affiliate, affiliate, 500);
        rs[1] = PactCore.FeeRecipient(PactCore.RecipientKind.Affiliate, makeAddr("a2"), 500);
        vm.prank(admin);
        vm.expectRevert(PactCore.TreasuryCardinalityViolation.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // C16 — per-entry bps cap on an Affiliate (not just Treasury)
    function test_C16_perEntryBpsCapOnAffiliate() public {
        PactCore.FeeRecipient[] memory rs = new PactCore.FeeRecipient[](2);
        rs[0] = PactCore.FeeRecipient(PactCore.RecipientKind.Treasury,  treasury, 100);
        rs[1] = PactCore.FeeRecipient(PactCore.RecipientKind.Affiliate, affiliate, 10_001);
        vm.prank(admin);
        vm.expectRevert(PactCore.InvalidFeeRecipients.selector);
        pact.registerEndpoint(SLUG_A, _defaultConfig(), rs);
    }

    // C17 — pause+unpause endpoint
    function test_C17_pauseThenUnpause() public {
        _registerDefault(SLUG_A);
        vm.prank(admin);
        pact.pauseEndpoint(SLUG_A, true);
        vm.prank(admin);
        pact.pauseEndpoint(SLUG_A, false);
        // Now a normal settle should succeed
        _settle(_mkRecord(bytes16("upu"), SLUG_A, false, 10_000, 0));
        assertEq(pact.callStatus(bytes16("upu")), 1);
    }

    // C18 — MockUsdc decimals returns 6
    function test_C18_mockUsdcDecimals() public {
        assertEq(usdc.decimals(), 6);
    }

    // C19 — updateEndpointConfig: every per-field set flag exercised
    function test_C19_updateAllConfigFields() public {
        _registerDefault(SLUG_A);
        PactCore.EndpointConfigUpdate memory upd = PactCore.EndpointConfigUpdate({
            setAgentTokenId:       true,  agentTokenId:       99,
            setFlatPremium:        true,  flatPremium:        2_000,
            setPercentBps:         true,  percentBps:         50,
            setImputedCost:        true,  imputedCost:        1_234,
            setLatencySloMs:       true,  latencySloMs:       7_777,
            setExposureCapPerHour: true,  exposureCapPerHour: 9_000
        });
        vm.prank(admin);
        pact.updateEndpointConfig(SLUG_A, upd);
        (uint256 agentId, uint96 flat, uint16 pctBps, uint96 imp, uint16 sloMs, uint96 cap,
         , , , , , , , , ) = pact.endpointConfig(SLUG_A);
        assertEq(agentId, 99);
        assertEq(flat,    2_000);
        assertEq(pctBps,  50);
        assertEq(imp,     1_234);
        assertEq(sloMs,   7_777);
        assertEq(cap,     9_000);
    }

    // C14 — MockUsdcFaucet: drip, cooldown revert
    function test_C14a_faucetDripWorks() public {
        MockUsdc t = new MockUsdc(address(this));
        MockUsdcFaucet f = new MockUsdcFaucet(t, 1_000e6, 1 days);
        t.transferOwnership(address(f));

        vm.prank(agent);
        f.drip();
        assertEq(t.balanceOf(agent), 1_000e6);
    }
    function test_C14b_faucetCooldownReverts() public {
        MockUsdc t = new MockUsdc(address(this));
        MockUsdcFaucet f = new MockUsdcFaucet(t, 1_000e6, 1 days);
        t.transferOwnership(address(f));

        vm.prank(agent);
        f.drip();
        vm.prank(agent);
        vm.expectRevert(); // CooldownActive
        f.drip();
    }
}

// ─────────────────────────────────────────────────────────────────────────
// ReentrantToken — minimal ERC20-compatible token whose `transfer()` and
// `transferFrom()` call back into `PactCore.settleBatch` when armed.
// Used by T11 to verify the ReentrancyGuard rejects the inner re-entry.
// ─────────────────────────────────────────────────────────────────────────
contract ReentrantToken {
    string  public name     = "Reentrant";
    string  public symbol   = "REENT";
    uint8   public constant decimals = 6;

    mapping(address => uint256)                      public balanceOf;
    mapping(address => mapping(address => uint256))  public allowance;

    PactCore public target;
    bool     public armed;

    function setTarget(PactCore _t) external { target = _t; }
    function arm() external                  { armed = true; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _maybeReenter() internal {
        if (armed) {
            armed = false; // one-shot to keep gas finite
            PactCore.SettlementRecord[] memory empty = new PactCore.SettlementRecord[](0);
            target.settleBatch(empty);
        }
    }

    /// @dev Reentry triggers ONLY on transfer (Step D fee transfer), not on
    ///      transferFrom (Step A premium debit). The premium-debit path is
    ///      wrapped in try/catch and absorbs reverts as DelegateFailed; the
    ///      fee-transfer path is the actual surface that `nonReentrant`
    ///      must protect against.
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        _maybeReenter();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        // intentionally NO reentry here
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// FalseReturningToken — compliant-shape ERC20 that returns false from
// transferFrom (some legacy tokens do this on insufficient allowance instead
// of reverting). Exercises C12: try block sees ok=false → DelegateFailed.
// ─────────────────────────────────────────────────────────────────────────
contract FalseReturningToken {
    string  public name     = "Liar";
    string  public symbol   = "LIAR";
    uint8   public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
