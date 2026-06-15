// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";

contract ProtocolInvariantsTest is Test {
    function test_ProtocolInvariantsMatchSolana() public pure {
        assertEq(ProtocolInvariants.MAX_BATCH_SIZE, 50, "MAX_BATCH_SIZE");
        assertEq(ProtocolInvariants.MIN_PREMIUM, 100, "MIN_PREMIUM");
        assertEq(ProtocolInvariants.MAX_FEE_RECIPIENTS, 8, "MAX_FEE_RECIPIENTS");
        assertEq(ProtocolInvariants.ABSOLUTE_FEE_BPS_CAP, 10_000, "ABSOLUTE_FEE_BPS_CAP");
        assertEq(ProtocolInvariants.DEFAULT_MAX_TOTAL_FEE_BPS, 3_000, "DEFAULT_MAX_TOTAL_FEE_BPS");
    }
}
