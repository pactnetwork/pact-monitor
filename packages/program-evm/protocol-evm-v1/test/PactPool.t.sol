// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {IPactPool} from "../src/interfaces/IPactPool.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";
import {MockUSDC} from "./util/MockUSDC.sol";
import "../src/errors/PactErrors.sol";

/// @notice Ported tests/01-pool.test.ts + top_up_coverage_pool.rs /
///         settle_batch.rs:360-498 parity-invariant + settler-hook isolation.
contract PactPoolTest is Test {
    MockUSDC usdc;
    PactRegistry reg;
    PactPool pool;

    address authority = makeAddr("authority");
    address treasuryVault = makeAddr("treasuryVault");
    address settler = makeAddr("settler");
    address funder = makeAddr("funder");
    bytes16 constant SLUG = bytes16("helius");
    bytes16 constant SLUG_B = bytes16("jupiter");

    /// @dev Cached so test bodies never make a `pool.SETTLER_ROLE()` external
    ///      call that would consume a single-shot `vm.prank`.
    bytes32 settlerRole;

    function setUp() public {
        usdc = new MockUSDC();
        IPactRegistry.FeeRecipient[8] memory d;
        d[0].kind = 0;
        d[0].destination = treasuryVault;
        d[0].bps = 1000;
        reg = new PactRegistry(
            authority, address(usdc), treasuryVault, ProtocolInvariants.DEFAULT_MAX_TOTAL_FEE_BPS, d, 1
        );
        pool = new PactPool(address(usdc), address(reg));
        settlerRole = pool.SETTLER_ROLE();
    }

    function _register(bytes16 slug) internal {
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        reg.registerEndpoint(slug, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    function test_Deploy_WiresUsdcRegistryAndAdmin() public view {
        assertEq(pool.usdc(), address(usdc));
        assertEq(address(pool.registry()), address(reg));
        // DEFAULT_ADMIN_ROLE (0x00) granted to registry.authority();
        // SETTLER_ROLE not yet granted.
        assertTrue(pool.hasRole(0x00, authority));
        assertFalse(pool.hasRole(pool.SETTLER_ROLE(), settler));
    }

    // --- Task 2: topUp (port of top_up_coverage_pool.rs) ---

    function test_TopUp_CreditsOnlyTargetedSlugPool() public {
        // Ported from 01-pool.test.ts "credits only the targeted slug pool"
        // — identical balance assertions.
        _register(SLUG);
        _register(SLUG_B);
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 500_000);
        vm.prank(authority);
        pool.topUp(SLUG, 500_000);

        assertEq(pool.balanceOf(SLUG).currentBalance, 500_000);
        assertEq(usdc.balanceOf(address(pool)), 500_000);
        assertEq(pool.balanceOf(SLUG_B).currentBalance, 0);
    }

    function test_TopUp_UpdatesTotalDeposits() public {
        _register(SLUG);
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 300_000);
        vm.prank(authority);
        pool.topUp(SLUG, 300_000);
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 300_000);
        assertEq(s.totalDeposits, 300_000);
    }

    function test_TopUp_RejectsNonAuthority() public {
        _register(SLUG);
        usdc.mint(funder, 1_000_000);
        vm.prank(funder);
        usdc.approve(address(pool), 500_000);
        vm.prank(funder);
        vm.expectRevert(UnauthorizedAuthority.selector);
        pool.topUp(SLUG, 500_000);
    }

    function test_TopUp_RejectsUnregisteredSlug() public {
        // EVM-meaningful residual of the N/A "mismatched pool/slug pair".
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 500_000);
        vm.prank(authority);
        vm.expectRevert(EndpointNotFound.selector);
        pool.topUp(SLUG, 500_000);
    }

    function test_TopUp_RevertsOnInsufficientAllowance() public {
        _register(SLUG);
        usdc.mint(authority, 1_000_000);
        // no approve
        vm.prank(authority);
        vm.expectRevert();
        pool.topUp(SLUG, 500_000);
    }

    // --- Task 3: balanceOf + ported register/isolation scenarios ---

    function test_BalanceOf_RegisteredPoolZeroInitialised() public {
        // Ported (parity subset) from 01-pool.test.ts "register_endpoint
        // creates per-slug coverage pool with correct state".
        _register(SLUG);
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 0);
        assertEq(s.totalDeposits, 0);
        assertEq(s.totalPremiums, 0);
        assertEq(s.totalRefunds, 0);
    }

    function test_BalanceOf_RevertsUnregistered() public {
        vm.expectRevert(EndpointNotFound.selector);
        pool.balanceOf(SLUG);
    }

    function test_TwoEndpointsIsolatedPools() public {
        // Ported (behavior) from 01-pool.test.ts "two endpoints have isolated
        // coverage pools".
        _register(SLUG);
        _register(SLUG_B);
        usdc.mint(authority, 1_000_000);
        vm.prank(authority);
        usdc.approve(address(pool), 400_000);
        vm.prank(authority);
        pool.topUp(SLUG, 400_000);
        assertEq(pool.balanceOf(SLUG).currentBalance, 400_000);
        assertEq(pool.balanceOf(SLUG_B).currentBalance, 0);
    }

    // --- Task 4: ArithmeticOverflow parity pin (D6, add direction) ---

    function test_TopUp_OverflowRevertsArithmeticOverflow() public {
        // Solana checked_add failure → PactError::ArithmeticOverflow. The EVM
        // port must revert the NAMED error, not a Solidity Panic(0x11).
        _register(SLUG);
        uint64 max = type(uint64).max;
        usdc.mint(authority, uint256(max) + 1);
        vm.startPrank(authority);
        usdc.approve(address(pool), uint256(max) + 1);
        pool.topUp(SLUG, max); // currentBalance = 2^64-1
        vm.expectRevert(ArithmeticOverflow.selector);
        pool.topUp(SLUG, 1); // overflow → named error, not Panic
        vm.stopPrank();
    }

    // --- Task 5: settler-gated hooks (settle_batch.rs:360-498, §4 #5) ---

    function _grantSettler() internal {
        vm.prank(authority); // DEFAULT_ADMIN_ROLE
        pool.grantRole(settlerRole, settler);
    }

    function test_Hooks_RejectNonSettler() public {
        _register(SLUG);
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, funder, settlerRole
            )
        );
        pool.creditPremium(SLUG, 100);
    }

    function test_CreditPremium_AddsBalanceAndPremiums() public {
        // settle_batch.rs:360-368 — current_balance += p AND total_premiums += p.
        _register(SLUG);
        _grantSettler();
        vm.prank(settler);
        pool.creditPremium(SLUG, 1000);
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 1000);
        assertEq(s.totalPremiums, 1000);
    }

    function test_DebitForFees_SubtractsBalance() public {
        // settle_batch.rs:448-453 — current_balance -= total_fee_paid.
        _register(SLUG);
        _grantSettler();
        vm.startPrank(settler);
        pool.creditPremium(SLUG, 1000);
        pool.debitForFees(SLUG, 300);
        vm.stopPrank();
        assertEq(pool.balanceOf(SLUG).currentBalance, 700);
    }

    function test_DebitForRefund_SubtractsBalanceAddsRefunds() public {
        // settle_batch.rs:481-490 — current_balance -= r AND total_refunds += r.
        _register(SLUG);
        _grantSettler();
        vm.startPrank(settler);
        pool.creditPremium(SLUG, 1000);
        pool.debitForRefund(SLUG, 250);
        vm.stopPrank();
        IPactPool.PoolState memory s = pool.balanceOf(SLUG);
        assertEq(s.currentBalance, 750);
        assertEq(s.totalRefunds, 250);
    }

    function test_DebitForFeesUnderflowRevertsArithmeticOverflow() public {
        // Solana checked_sub failure → PactError::ArithmeticOverflow (D6, sub).
        _register(SLUG);
        _grantSettler();
        vm.prank(settler);
        vm.expectRevert(ArithmeticOverflow.selector);
        pool.debitForFees(SLUG, 1);
    }

    function test_DebitForRefundUnderflowRevertsArithmeticOverflow() public {
        // D6 condition: EVERY debit hook, both directions, named error.
        _register(SLUG);
        _grantSettler();
        vm.prank(settler);
        vm.expectRevert(ArithmeticOverflow.selector);
        pool.debitForRefund(SLUG, 1);
    }

    function test_CreditPremiumOverflowRevertsArithmeticOverflow() public {
        // D6 condition: checked_add overflow on creditPremium → named error.
        _register(SLUG);
        _grantSettler();
        uint64 max = type(uint64).max;
        vm.startPrank(settler);
        pool.creditPremium(SLUG, max); // currentBalance = totalPremiums = 2^64-1
        vm.expectRevert(ArithmeticOverflow.selector);
        pool.creditPremium(SLUG, 1);
        vm.stopPrank();
    }

    function test_Payout_OnlySettler_TransfersUsdc() public {
        _register(SLUG);
        _grantSettler();
        usdc.mint(authority, 1_000);
        vm.startPrank(authority);
        usdc.approve(address(pool), 1_000);
        pool.topUp(SLUG, 1_000);
        vm.stopPrank();
        vm.prank(settler);
        pool.payout(funder, 400);
        assertEq(usdc.balanceOf(funder), 400);
        assertEq(usdc.balanceOf(address(pool)), 600);
    }

    function test_Payout_RejectsNonSettler() public {
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, funder, settlerRole
            )
        );
        pool.payout(funder, 1);
    }
}
