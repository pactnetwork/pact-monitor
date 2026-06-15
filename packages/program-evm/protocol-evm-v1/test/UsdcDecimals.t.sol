// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";
import {MockUSDC} from "./util/MockUSDC.sol";

/// @dev 18-decimal token — the negative control proving the guard bites.
contract Mock18 is ERC20 {
    constructor() ERC20("Wrong", "WRG") {}
    function decimals() public pure override returns (uint8) { return 18; }
}

/// @title Live USDC decimals assertion (WP-EVM-06 T8)
/// @notice Deferred from WP-EVM-01: Pact's premium math assumes 6-decimal
///         USDC (Solana parity, design §2/§4 #8). This asserts the live
///         `IERC20Metadata(USDC).decimals()` equals
///         `ProtocolInvariants.EXPECTED_USDC_DECIMALS` so a decimals mismatch fails
///         loudly rather than silently corrupting every premium/fee/refund.
///         The same require() guard wires into the WP-EVM-07 deploy script.
contract UsdcDecimalsTest is Test {
    /// @dev Reverts loudly on a decimals mismatch (the production guard shape).
    function requireUsdcDecimals(address token) public view {
        require(
            IERC20Metadata(token).decimals() == ProtocolInvariants.EXPECTED_USDC_DECIMALS,
            "USDC_DECIMALS_MISMATCH"
        );
    }

    function test_MockUsdcHasSixDecimals() public {
        MockUSDC usdc = new MockUSDC();
        assertEq(usdc.decimals(), ProtocolInvariants.EXPECTED_USDC_DECIMALS, "USDC must be 6-decimal");
        assertEq(ProtocolInvariants.EXPECTED_USDC_DECIMALS, 6);
        // Live guard passes for a correct 6-decimal token.
        this.requireUsdcDecimals(address(usdc));
    }

    /// @notice WP-MN-01 Gate B exit step 3: "USDC-decimals deploy guard fires
    ///         on a synthetic 18-decimals chain entry (negative test)." This
    ///         test materializes a synthetic 18-decimal token (the Mock18 above)
    ///         and proves the guard reverts loudly with the production error
    ///         shape ("USDC_DECIMALS_MISMATCH").
    function test_GuardRevertsOnSynthetic18DecimalChain() public {
        Mock18 bad = new Mock18();
        // Non-vacuous: the guard distinguishes a wrong-decimals token.
        assertTrue(bad.decimals() != ProtocolInvariants.EXPECTED_USDC_DECIMALS);
        vm.expectRevert(bytes("USDC_DECIMALS_MISMATCH"));
        this.requireUsdcDecimals(address(bad));
    }
}
