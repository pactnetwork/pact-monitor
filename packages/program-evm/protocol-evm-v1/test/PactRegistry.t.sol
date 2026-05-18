// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {ArcConfig} from "../src/ArcConfig.sol";
import {MockUSDC} from "./util/MockUSDC.sol";
import "../src/errors/PactErrors.sol";

/// @notice Ported LiteSVM registry scenarios. Sources of truth:
///         initialize_protocol_config.rs (→ constructor, §4 #6),
///         register_endpoint.rs, update_endpoint_config.rs,
///         update_fee_recipients.rs, pause_endpoint.rs, pause_protocol.rs.
///         Oracle files: 00-protocol-config, 02-endpoint, 06-pause
///         (endpoint cases), 10-pause-protocol. 00-treasury + PDA/SPL
///         mechanics scenarios are N/A-on-EVM (§4 #2/#6/#7) — see the
///         PORT/N-A table in the Task 6 commit message + Task 7 notes.
contract PactRegistryTest is Test {
    MockUSDC usdc;
    address authority = makeAddr("authority");
    address treasuryVault = makeAddr("treasuryVault");
    address attacker = makeAddr("attacker");
    address aff1 = makeAddr("aff1");
    address aff2 = makeAddr("aff2");

    bytes16 constant SLUG = bytes16("helius");

    function setUp() public {
        usdc = new MockUSDC();
    }

    // --- helpers ---

    function _rec(uint8 k, address d, uint16 b)
        internal
        pure
        returns (IPactRegistry.FeeRecipient memory r)
    {
        r.kind = k;
        r.destination = d;
        r.bps = b;
    }

    function _emptyArr() internal pure returns (IPactRegistry.FeeRecipient[8] memory a) {}

    // Default template = 1 Treasury at 1000 bps (mirrors setupProtocolAndTreasury).
    function _defaultsTreasury1000()
        internal
        view
        returns (IPactRegistry.FeeRecipient[8] memory a, uint8 count)
    {
        a[0] = _rec(0, treasuryVault, 1000);
        count = 1;
    }

    function _deploy() internal returns (PactRegistry reg) {
        (IPactRegistry.FeeRecipient[8] memory d, uint8 c) = _defaultsTreasury1000();
        reg = new PactRegistry(
            authority, address(usdc), treasuryVault, ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS, d, c
        );
    }

    function _register(
        PactRegistry reg,
        bytes16 slug,
        bool present,
        IPactRegistry.FeeRecipient[8] memory recips,
        uint8 count
    ) internal {
        vm.prank(authority);
        reg.registerEndpoint(slug, 500, 0, 5000, 1000, 5_000_000, present, count, recips);
    }

    // =====================================================================
    // Constructor  ← initialize_protocol_config.rs:84-156 (§4 #6)
    // =====================================================================

    function test_Constructor_HappyDefaultTreasury() public {
        PactRegistry reg = _deploy();
        assertEq(reg.maxTotalFeeBps(), 3000, "default cap");
        assertEq(reg.authority(), authority);
        assertEq(reg.treasuryVault(), treasuryVault);
        assertEq(reg.protocolPaused(), false);
    }

    function test_Constructor_RejectsMaxTotalOver10k() public {
        // rs:84-86 — the extra config check unique to init_pc.
        (IPactRegistry.FeeRecipient[8] memory d, uint8 c) = _defaultsTreasury1000();
        vm.expectRevert(FeeBpsExceedsCap.selector);
        new PactRegistry(authority, address(usdc), treasuryVault, 10001, d, c);
    }

    function test_Constructor_RejectsSumOver10k() public {
        // maxTotal 11000 > 10_000 → FeeBpsExceedsCap (rs:84-86 fires before
        // the entry loop). Mirrors 00-protocol-config "rejects sum > 10000".
        IPactRegistry.FeeRecipient[8] memory d;
        d[0] = _rec(0, treasuryVault, 9000);
        d[1] = _rec(1, aff1, 2000);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        new PactRegistry(authority, address(usdc), treasuryVault, 11000, d, 2);
    }

    function test_Constructor_RejectsDuplicateDestinations() public {
        IPactRegistry.FeeRecipient[8] memory d;
        d[0] = _rec(1, aff1, 500);
        d[1] = _rec(1, aff1, 200);
        vm.expectRevert(FeeRecipientDuplicateDestination.selector);
        new PactRegistry(authority, address(usdc), treasuryVault, 3000, d, 2);
    }

    function test_Constructor_RejectsMultipleTreasury() public {
        IPactRegistry.FeeRecipient[8] memory d;
        d[0] = _rec(0, treasuryVault, 500);
        d[1] = _rec(0, aff1, 500);
        vm.expectRevert(MultipleTreasuryRecipients.selector);
        new PactRegistry(authority, address(usdc), treasuryVault, 3000, d, 2);
    }

    function test_Constructor_AcceptsEmptyDefaultTemplate() public {
        // rs:138 — count == 0 is INTENTIONALLY allowed (operators may require
        // per-endpoint recipients). Parity: must NOT revert.
        IPactRegistry.FeeRecipient[8] memory d;
        PactRegistry reg =
            new PactRegistry(authority, address(usdc), treasuryVault, 3000, d, 0);
        assertEq(reg.maxTotalFeeBps(), 3000);
        // register_endpoint.rs default-copy path then runs
        // validate_post_substitution on the empty template → MissingTreasuryEntry.
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(authority);
        vm.expectRevert(MissingTreasuryEntry.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    // =====================================================================
    // register_endpoint.rs  (02-endpoint.test.ts)
    // =====================================================================

    function test_Register_ExplicitRecipientsWritten() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 1000); // Treasury, wire dest substituted
        r[1] = _rec(1, aff1, 500);
        _register(reg, SLUG, true, r, 2);

        IPactRegistry.EndpointConfig memory c = reg.getEndpoint(SLUG);
        assertEq(c.feeRecipientCount, 2);
        assertEq(c.feeRecipients[0].kind, 0);
        assertEq(c.feeRecipients[0].destination, treasuryVault); // substituted
        assertEq(c.feeRecipients[0].bps, 1000);
        assertEq(c.feeRecipients[1].kind, 1);
        assertEq(c.feeRecipients[1].destination, aff1);
        assertEq(c.feeRecipients[1].bps, 500);
        assertTrue(reg.isRegistered(SLUG));
    }

    function test_Register_DefaultTemplateCopies() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);

        IPactRegistry.EndpointConfig memory c = reg.getEndpoint(SLUG);
        assertEq(c.feeRecipientCount, 1); // default count
        assertEq(c.feeRecipients[0].kind, 0);
        assertEq(c.feeRecipients[0].bps, 1000);
        assertEq(c.feeRecipients[0].destination, treasuryVault);
    }

    function test_Register_RejectsSumOver10k() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(1, aff1, 6000);
        r[1] = _rec(1, aff2, 6000); // sum 12000
        vm.prank(authority);
        vm.expectRevert(FeeBpsSumOver10k.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 2, r);
    }

    function test_Register_RejectsSumOverMaxTotal() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(1, aff1, 4000); // > 3000 default max_total
        vm.prank(authority);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 1, r);
    }

    function test_Register_RejectsDuplicateDestination() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(1, aff1, 500);
        r[1] = _rec(1, aff1, 500);
        vm.prank(authority);
        vm.expectRevert(FeeRecipientDuplicateDestination.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 2, r);
    }

    function test_Register_RejectsMultipleTreasury() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 500);
        r[1] = _rec(0, aff1, 500);
        vm.prank(authority);
        vm.expectRevert(MultipleTreasuryRecipients.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 2, r);
    }

    function test_Register_RejectsNonAuthority() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        vm.prank(attacker);
        vm.expectRevert(UnauthorizedAuthority.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    function test_Register_RejectsZeroEntryMissingTreasury() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        vm.prank(authority);
        vm.expectRevert(MissingTreasuryEntry.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 0, r);
    }

    function test_Register_RejectsTreasuryBpsZero() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 0);
        vm.prank(authority);
        vm.expectRevert(TreasuryBpsZero.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 1, r);
    }

    function test_Register_RejectsAffiliateAliasingTreasuryVaultPostSub() public {
        // Treasury wire dest unused; affiliate points at treasuryVault.
        // After substitution both == treasuryVault → dup (register_endpoint.rs
        // validate_post_substitution). Mirrors 02-endpoint "AffiliateAta ==
        // Treasury vault post-substitution".
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 500);
        r[1] = _rec(1, treasuryVault, 500);
        vm.prank(authority);
        vm.expectRevert(FeeRecipientDuplicateDestination.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, true, 2, r);
    }

    function test_Register_RejectsInvalidSlug() public {
        // register_endpoint.rs: byte b != 0 && (b < 0x20 || b > 0x7E) →
        // InvalidSlug. 0x01 is a control byte.
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        bytes16 badSlug = bytes16(hex"01000000000000000000000000000000");
        vm.prank(authority);
        vm.expectRevert(InvalidSlug.selector);
        reg.registerEndpoint(badSlug, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    function test_Register_RejectsDuplicateSlug() public {
        // register_endpoint.rs: !endpoint.is_data_empty() →
        // EndpointAlreadyRegistered. (Parity invariant, plan Task 6.)
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        vm.prank(authority);
        vm.expectRevert(EndpointAlreadyRegistered.selector);
        reg.registerEndpoint(SLUG, 500, 0, 5000, 1000, 5_000_000, false, 0, none);
    }

    function test_Register_StatsZeroInitialised() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        IPactRegistry.EndpointConfig memory c = reg.getEndpoint(SLUG);
        assertEq(c.totalCalls, 0);
        assertEq(c.totalBreaches, 0);
        assertEq(c.totalPremiums, 0);
        assertEq(c.totalRefunds, 0);
        assertEq(c.currentPeriodRefunds, 0);
        assertEq(c.paused, false);
        assertEq(c.currentPeriodStart, uint64(block.timestamp));
        assertEq(c.lastUpdated, uint64(block.timestamp));
    }

    // =====================================================================
    // update_fee_recipients.rs / update_endpoint_config.rs (02-endpoint)
    // =====================================================================

    function test_UpdateFeeRecipients_ReplacesAndValidates() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);

        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 800);
        r[1] = _rec(1, aff1, 200);
        vm.prank(authority);
        reg.updateFeeRecipients(SLUG, r, 2);

        IPactRegistry.EndpointConfig memory c = reg.getEndpoint(SLUG);
        assertEq(c.feeRecipientCount, 2);
        assertEq(c.feeRecipients[0].bps, 800);
        assertEq(c.feeRecipients[0].destination, treasuryVault);
        assertEq(c.feeRecipients[1].bps, 200);
        assertEq(c.feeRecipients[1].destination, aff1);

        // Bad update: per-entry 11000 > 10_000 → FeeBpsExceedsCap.
        IPactRegistry.FeeRecipient[8] memory bad;
        bad[0] = _rec(1, aff1, 11000);
        vm.prank(authority);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        reg.updateFeeRecipients(SLUG, bad, 1);
    }

    function test_UpdateFeeRecipients_RejectsUnregistered() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 1000);
        vm.prank(authority);
        vm.expectRevert(EndpointNotFound.selector);
        reg.updateFeeRecipients(SLUG, r, 1);
    }

    function test_UpdateFeeRecipients_RejectsNonAuthority() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 1000);
        vm.prank(attacker);
        vm.expectRevert(UnauthorizedAuthority.selector);
        reg.updateFeeRecipients(SLUG, r, 1);
    }

    function test_UpdateEndpointConfig_UpdatesFlatPremium() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);

        IPactRegistry.EndpointConfig memory pre = reg.getEndpoint(SLUG);
        vm.prank(authority);
        reg.updateEndpointConfig(
            SLUG, 999, pre.percentBps, pre.slaLatencyMs, pre.imputedCost, pre.exposureCapPerHour
        );
        assertEq(reg.getEndpoint(SLUG).flatPremium, 999);
    }

    function test_UpdateEndpointConfig_RejectsUnregistered() public {
        PactRegistry reg = _deploy();
        vm.prank(authority);
        vm.expectRevert(EndpointNotFound.selector);
        reg.updateEndpointConfig(SLUG, 999, 0, 5000, 1000, 5_000_000);
    }

    function test_UpdateEndpointConfig_RejectsNonAuthority() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        vm.prank(attacker);
        vm.expectRevert(UnauthorizedAuthority.selector);
        reg.updateEndpointConfig(SLUG, 999, 0, 5000, 1000, 5_000_000);
    }

    // =====================================================================
    // pause_endpoint.rs  (06-pause.test.ts endpoint cases)
    // =====================================================================

    function test_PauseEndpoint_SetsPaused() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        vm.prank(authority);
        reg.pauseEndpoint(SLUG, true);
        assertTrue(reg.getEndpoint(SLUG).paused);
    }

    function test_PauseEndpoint_CanUnpause() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        vm.prank(authority);
        reg.pauseEndpoint(SLUG, true);
        vm.prank(authority);
        reg.pauseEndpoint(SLUG, false);
        assertFalse(reg.getEndpoint(SLUG).paused);
    }

    function test_PauseEndpoint_RejectsNonAuthority() public {
        PactRegistry reg = _deploy();
        IPactRegistry.FeeRecipient[8] memory none;
        _register(reg, SLUG, false, none, 0);
        vm.prank(attacker);
        vm.expectRevert(UnauthorizedAuthority.selector);
        reg.pauseEndpoint(SLUG, true);
    }

    function test_PauseEndpoint_RejectsUnregistered() public {
        PactRegistry reg = _deploy();
        vm.prank(authority);
        vm.expectRevert(EndpointNotFound.selector);
        reg.pauseEndpoint(SLUG, true);
    }

    // =====================================================================
    // pause_protocol.rs  (10-pause-protocol.test.ts)
    // =====================================================================

    function test_PauseProtocol_SetAndClear() public {
        PactRegistry reg = _deploy();
        assertFalse(reg.protocolPaused());
        vm.prank(authority);
        reg.pauseProtocol(true);
        assertTrue(reg.protocolPaused());
        vm.prank(authority);
        reg.pauseProtocol(false);
        assertFalse(reg.protocolPaused());
    }

    function test_PauseProtocol_RejectsNonAuthority() public {
        PactRegistry reg = _deploy();
        vm.prank(attacker);
        vm.expectRevert(UnauthorizedAuthority.selector);
        reg.pauseProtocol(true);
        assertFalse(reg.protocolPaused());
    }
}
