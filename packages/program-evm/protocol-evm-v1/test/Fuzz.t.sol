// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PactSettler} from "../src/PactSettler.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {IPactSettler} from "../src/interfaces/IPactSettler.sol";
import {IPactPool} from "../src/interfaces/IPactPool.sol";
import {ArcConfig} from "../src/ArcConfig.sol";
import {MockUSDC} from "./util/MockUSDC.sol";
import "../src/errors/PactErrors.sol";

/// @title PactSettler fuzz / property suite (WP-EVM-06 T7)
/// @notice ADDITIVE consolidated fuzz coverage on top of the 102 ported
///         scenario tests. NO contract change. The parity oracle is the
///         design-spec §3 fee-split formula `premium * bps / 10_000` with
///         u64 integer floor division (bit-identical to Solana Rust u64
///         floor div; the proven WP-02/04 scenario oracle). A fuzz-found
///         divergence from this oracle is a genuine parity defect in LOCKED
///         contract code -> WP-EVM-06 STOP-AND-ASK Trigger 1: HALT, do NOT
///         touch contract code, escalate with the failing input.
contract FuzzTest is Test {
    MockUSDC usdc;
    PactRegistry reg;
    PactPool pool;
    PactSettler settler;

    address authority     = makeAddr("authority");
    address treasuryVault = makeAddr("treasuryVault");
    address affiliate     = makeAddr("affiliate");
    address settlerSigner = makeAddr("settlerSigner");
    address agent         = makeAddr("agent");

    bytes16 constant SLUG = bytes16("helius");

    function setUp() public {
        // Sane wall clock so `block.timestamp - tsOffset` never underflows.
        vm.warp(1_700_000_000);

        usdc = new MockUSDC();

        IPactRegistry.FeeRecipient[8] memory d;
        d[0].kind = 0;
        d[0].destination = treasuryVault;
        d[0].bps = 1000;

        reg = new PactRegistry(authority, address(usdc), treasuryVault, 3000, d, 1);
        pool = new PactPool(address(usdc), address(reg));
        settler = new PactSettler(address(usdc), address(reg), address(pool));

        bytes32 poolSettlerRole = pool.SETTLER_ROLE();
        bytes32 regSettlerRole  = reg.SETTLER_ROLE();
        bytes32 settlerRole     = settler.SETTLER_ROLE();

        vm.prank(authority);
        pool.grantRole(poolSettlerRole, address(settler));
        vm.prank(authority);
        reg.grantRole(regSettlerRole, address(settler));
        vm.prank(authority);
        settler.grantRole(settlerRole, settlerSigner);
    }

    // --- helpers (mirror PactSettler.t.sol harness) ---

    function _fundPool(bytes16 slug, uint64 amount) internal {
        usdc.mint(authority, amount);
        vm.prank(authority);
        usdc.approve(address(pool), amount);
        vm.prank(authority);
        pool.topUp(slug, amount);
    }

    function _provisionAgent(uint64 mintAmount, uint64 allowance) internal {
        usdc.mint(agent, mintAmount);
        vm.prank(agent);
        usdc.approve(address(settler), allowance);
    }

    function _ev(uint8 seed, uint64 premium, uint8 feeCountHint)
        internal
        view
        returns (IPactSettler.SettlementEvent memory ev)
    {
        bytes memory b = new bytes(16);
        for (uint256 i = 0; i < 16; i++) b[i] = bytes1(seed);
        bytes16 callId;
        assembly { callId := mload(add(b, 32)) }
        ev = IPactSettler.SettlementEvent({
            callId: callId,
            agent: agent,
            endpointSlug: SLUG,
            premium: premium,
            refund: 0,
            latencyMs: 10,
            breach: false,
            feeRecipientCountHint: feeCountHint,
            timestamp: uint64(block.timestamp) - 1
        });
    }

    // -----------------------------------------------------------------------
    // PROPERTY 1 — single-recipient fee-split rounding + conservation.
    // Oracle: treasury gets floor(premium * bps / 10000); pool keeps the
    // residual; nothing is created or lost (spec §3 "no rounding drift").
    // -----------------------------------------------------------------------
    function testFuzz_FeeSplitSingleRecipient(uint64 premiumRaw, uint16 bpsRaw) public {
        uint64 premium = uint64(bound(premiumRaw, ArcConfig.MIN_PREMIUM, 1e15));
        uint16 bps = uint16(bound(bpsRaw, 1, 3000)); // <= default maxTotalFeeBps

        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = IPactRegistry.FeeRecipient({kind: 0, destination: treasuryVault, bps: bps});
        vm.prank(authority);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 1, r);

        uint64 deposit = 1_000_000;
        _fundPool(SLUG, deposit);
        _provisionAgent(premium, premium);

        uint256 tBefore = usdc.balanceOf(treasuryVault);
        IPactSettler.SettlementEvent[] memory evs = new IPactSettler.SettlementEvent[](1);
        evs[0] = _ev(0x11, premium, 1);
        vm.prank(settlerSigner);
        settler.settleBatch(evs);

        uint256 expectedFee = (uint256(premium) * bps) / 10_000; // §3 oracle
        assertEq(
            usdc.balanceOf(treasuryVault) - tBefore,
            expectedFee,
            "treasury fee != floor(premium*bps/10000) -- Trigger-1 parity defect"
        );
        IPactPool.PoolState memory ps = pool.balanceOf(SLUG);
        assertEq(
            uint256(ps.currentBalance),
            uint256(deposit) + premium - expectedFee,
            "pool residual != premium - fee -- Trigger-1 parity defect"
        );
        // Conservation: pool delta + treasury delta == premium (nothing lost).
        assertEq(
            (uint256(ps.currentBalance) - deposit) + expectedFee,
            uint256(premium),
            "value not conserved across the split"
        );
    }

    // -----------------------------------------------------------------------
    // PROPERTY 2 — multi-recipient split: SUM of floors paid out, pool keeps
    // the exact residual, never over- or under-pays.
    // -----------------------------------------------------------------------
    function testFuzz_FeeSplitMultiRecipient(
        uint64 premiumRaw,
        uint16 tBpsRaw,
        uint16 aBpsRaw
    ) public {
        uint64 premium = uint64(bound(premiumRaw, ArcConfig.MIN_PREMIUM, 1e15));
        uint16 tBps = uint16(bound(tBpsRaw, 1, 1500));
        uint16 aBps = uint16(bound(aBpsRaw, 1, 1500)); // tBps+aBps <= 3000

        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = IPactRegistry.FeeRecipient({kind: 0, destination: treasuryVault, bps: tBps});
        r[1] = IPactRegistry.FeeRecipient({kind: 1, destination: affiliate, bps: aBps});
        vm.prank(authority);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 2, r);

        uint64 deposit = 1_000_000;
        _fundPool(SLUG, deposit);
        _provisionAgent(premium, premium);

        uint256 tBefore = usdc.balanceOf(treasuryVault);
        uint256 aBefore = usdc.balanceOf(affiliate);
        IPactSettler.SettlementEvent[] memory evs = new IPactSettler.SettlementEvent[](1);
        evs[0] = _ev(0x22, premium, 2);
        vm.prank(settlerSigner);
        settler.settleBatch(evs);

        uint256 tFee = (uint256(premium) * tBps) / 10_000;
        uint256 aFee = (uint256(premium) * aBps) / 10_000;
        assertEq(usdc.balanceOf(treasuryVault) - tBefore, tFee, "treasury floor mismatch");
        assertEq(usdc.balanceOf(affiliate) - aBefore, aFee, "affiliate floor mismatch");

        IPactPool.PoolState memory ps = pool.balanceOf(SLUG);
        assertEq(
            uint256(ps.currentBalance),
            uint256(deposit) + premium - tFee - aFee,
            "pool residual != premium - sum(fees)"
        );
        assertLe(tFee + aFee, uint256(premium), "fees exceed premium");
    }

    // -----------------------------------------------------------------------
    // PROPERTY 3 — batch-size handling: 1..50 settle; >50 reverts BatchTooLarge.
    // -----------------------------------------------------------------------
    function testFuzz_BatchWithinLimitSettles(uint8 nRaw) public {
        uint256 n = bound(nRaw, 1, ArcConfig.MAX_BATCH_SIZE); // 1..50
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
        _fundPool(SLUG, 1_000_000);
        uint64 premium = 1_000;
        _provisionAgent(uint64(premium * n), uint64(premium * n));

        // feeRecipientsPresent=false copies the default Treasury template
        // (stored feeRecipientCount = 1, ruling #5) -> hint must be 1.
        IPactSettler.SettlementEvent[] memory evs = new IPactSettler.SettlementEvent[](n);
        for (uint256 i = 0; i < n; i++) evs[i] = _ev(uint8(i + 1), premium, 1);

        vm.prank(settlerSigner);
        settler.settleBatch(evs); // must NOT revert for n in [1,50]

        assertEq(reg.getEndpoint(SLUG).totalCalls, uint64(n), "all n calls recorded");
    }

    function testFuzz_BatchOverLimitReverts(uint16 nRaw) public {
        uint256 n = bound(nRaw, ArcConfig.MAX_BATCH_SIZE + 1, 300); // 51..300
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, false, 0, none);

        IPactSettler.SettlementEvent[] memory evs = new IPactSettler.SettlementEvent[](n);
        for (uint256 i = 0; i < n; i++) evs[i] = _ev(uint8(i + 1), 1_000, 0);

        vm.prank(settlerSigner);
        vm.expectRevert(BatchTooLarge.selector);
        settler.settleBatch(evs);
    }

    // -----------------------------------------------------------------------
    // PROPERTY 4 — dedup invariant: a replayed callId reverts DuplicateCallId
    // regardless of its position in the batch.
    // -----------------------------------------------------------------------
    function testFuzz_DuplicateCallIdRevertsAnyPosition(uint8 dupPosRaw) public {
        uint256 n = 6;
        uint256 dupPos = bound(dupPosRaw, 1, n - 1); // collide event[dupPos] with event[0]
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
        _fundPool(SLUG, 1_000_000);
        _provisionAgent(uint64(1_000 * n), uint64(1_000 * n));

        IPactSettler.SettlementEvent[] memory evs = new IPactSettler.SettlementEvent[](n);
        for (uint256 i = 0; i < n; i++) evs[i] = _ev(uint8(i + 1), 1_000, 1);
        evs[dupPos] = _ev(uint8(1), 1_000, 1); // same callId seed as evs[0]

        vm.prank(settlerSigner);
        vm.expectRevert(DuplicateCallId.selector);
        settler.settleBatch(evs);
    }
}
