// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {IPactPool} from "../src/interfaces/IPactPool.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {ArcConfig} from "../src/ArcConfig.sol";
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

    function setUp() public {
        usdc = new MockUSDC();
        IPactRegistry.FeeRecipient[8] memory d;
        d[0].kind = 0;
        d[0].destination = treasuryVault;
        d[0].bps = 1000;
        reg = new PactRegistry(
            authority, address(usdc), treasuryVault, ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS, d, 1
        );
        pool = new PactPool(address(usdc), address(reg));
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
}
