// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {FeeValidation} from "../src/libraries/FeeValidation.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import "../src/errors/PactErrors.sol";

/// @dev `FeeValidation.validate` is an internal library fn; it inlines into
///      the caller and would revert at the same depth as the expectRevert
///      cheatcode. This thin external wrapper moves the revert to a deeper
///      call frame so `vm.expectRevert` works. Pure pass-through — no parity
///      semantics added or changed.
contract FeeValidationHarness {
    function validate(
        IPactRegistry.FeeRecipient[8] memory recipients,
        uint8 count,
        uint16 maxTotalFeeBps,
        address treasuryVault
    ) external pure returns (uint32) {
        return FeeValidation.validate(recipients, count, maxTotalFeeBps, treasuryVault);
    }
}

/// @notice Parity oracle for the fee.rs port. Validation order/errors are
///         pinned against Solana fee.rs (parse_and_validate fee.rs:44-90 →
///         substitute_treasury_destination :96-106 → validate_post_substitution
///         :128-161). validate_affiliate_atas (:175-217) is dropped per design
///         spec §4 #7 (no EVM equivalent). FeeBpsSumOver10k vs FeeBpsExceedsCap
///         mapping per captain decision (B); precedence tests per (C).
contract FeeValidationTest is Test {
    FeeValidationHarness harness = new FeeValidationHarness();

    address T = makeAddr("treasury");
    address TV = makeAddr("treasuryVault");
    address A1 = makeAddr("affiliate1");
    address T2 = makeAddr("treasury2");
    address DUP = makeAddr("dup");

    function _rec(uint8 k, address d, uint16 b)
        internal
        pure
        returns (IPactRegistry.FeeRecipient memory r)
    {
        r.kind = k;
        r.destination = d;
        r.bps = b;
    }

    // --- 9 plan scenarios (parity-verified against fee.rs) ---

    function test_AcceptsSingleTreasuryPlusAffiliate() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 1000);
        r[1] = _rec(1, A1, 500);
        uint32 sum = harness.validate(r, 2, 3000, T);
        assertEq(sum, 1500);
    }

    function test_RejectsTwoTreasury() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 1000);
        r[1] = _rec(0, T2, 500);
        vm.expectRevert(MultipleTreasuryRecipients.selector);
        harness.validate(r, 2, 3000, T);
    }

    function test_RejectsTreasuryBpsZero() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 0);
        vm.expectRevert(TreasuryBpsZero.selector);
        harness.validate(r, 1, 3000, T);
    }

    function test_RejectsMissingTreasury() public {
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(1, A1, 500);
        vm.expectRevert(MissingTreasuryEntry.selector);
        harness.validate(r, 1, 3000, T);
    }

    function test_RejectsSumOverMaxTotal() public {
        // sum 4000 ≤ 10_000 but > maxTotal 3000 → FeeBpsExceedsCap (fee.rs:86-88)
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 2000);
        r[1] = _rec(1, A1, 2000);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        harness.validate(r, 2, 3000, T);
    }

    function test_RejectsPerEntryOverAbsoluteCap() public {
        // per-entry bps 10001 > 10_000 → FeeBpsExceedsCap (fee.rs:64-66)
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 10001);
        vm.expectRevert(FeeBpsExceedsCap.selector);
        harness.validate(r, 1, 10000, T);
    }

    function test_RejectsDuplicateDestinationPostSubstitution() public {
        // Affiliate aliasing the treasury vault must be rejected AFTER the
        // Treasury destination is substituted (fee.rs validate_post_substitution
        // :153-159). Pre-sub destinations differ (address(0) vs TV).
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, address(0), 1000); // Treasury, wire dest unused
        r[1] = _rec(1, TV, 500); // Affiliate == treasury vault
        vm.expectRevert(FeeRecipientDuplicateDestination.selector);
        harness.validate(r, 2, 3000, TV);
    }

    function test_RejectsCountOverMax() public {
        // count 9 > MAX_FEE_RECIPIENTS(8) → FeeRecipientArrayTooLong, checked
        // FIRST before any indexing (fee.rs:49-51).
        IPactRegistry.FeeRecipient[8] memory r;
        vm.expectRevert(FeeRecipientArrayTooLong.selector);
        harness.validate(r, 9, 3000, T);
    }

    function test_RejectsInvalidKind() public {
        // kind 3 → from_u8 None → InvalidFeeRecipientKind (fee.rs decode_entry
        // :24-27), caught at the start of the entry's iteration.
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 1000);
        r[1] = _rec(3, A1, 500);
        vm.expectRevert(InvalidFeeRecipientKind.selector);
        harness.validate(r, 2, 3000, T);
    }

    // --- captain decision (B): sum > ABSOLUTE_FEE_BPS_CAP → FeeBpsSumOver10k ---

    function test_RejectsSumOverAbsoluteCap() public {
        // Treasury 6000 + Affiliate 5000 = 11000 > 10_000 → FeeBpsSumOver10k
        // (fee.rs:83-85), checked BEFORE the > maxTotal check (fee.rs:86-88).
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 6000);
        r[1] = _rec(1, A1, 5000);
        vm.expectRevert(FeeBpsSumOver10k.selector);
        harness.validate(r, 2, 10000, T);
    }

    // --- captain decision (C): fee.rs precedence pinning ---

    function test_PrecedenceRawDuplicateBeatsSumOver10k() public {
        // Raw (pre-substitution) duplicate AND sum 11000 > 10_000. Solana
        // catches the duplicate IN-LOOP (fee.rs:73-77) before the post-loop
        // sum check (fee.rs:83-85). treasuryVault differs from the dup address
        // so this pins the PRE-substitution in-loop dup precedence.
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, DUP, 6000);
        r[1] = _rec(1, DUP, 5000);
        vm.expectRevert(FeeRecipientDuplicateDestination.selector);
        harness.validate(r, 2, 10000, T);
    }

    function test_PrecedenceMultipleTreasuryBeatsSumOverMaxTotal() public {
        // 2× Treasury AND sum 4000 > maxTotal 3000. Solana catches the second
        // Treasury IN-LOOP (fee.rs:67-72) before the post-loop > maxTotal
        // check (fee.rs:86-88).
        IPactRegistry.FeeRecipient[8] memory r;
        r[0] = _rec(0, T, 2000);
        r[1] = _rec(0, T2, 2000);
        vm.expectRevert(MultipleTreasuryRecipients.selector);
        harness.validate(r, 2, 3000, T);
    }
}
