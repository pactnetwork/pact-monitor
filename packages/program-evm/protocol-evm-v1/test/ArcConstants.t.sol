// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ArcConfig} from "../src/ArcConfig.sol";

contract ArcConstantsTest is Test {
    function test_PortedConstantsMatchSolana() public pure {
        assertEq(ArcConfig.MAX_BATCH_SIZE, 50, "MAX_BATCH_SIZE");
        assertEq(ArcConfig.MIN_PREMIUM, 100, "MIN_PREMIUM");
        assertEq(ArcConfig.MAX_FEE_RECIPIENTS, 8, "MAX_FEE_RECIPIENTS");
        assertEq(ArcConfig.ABSOLUTE_FEE_BPS_CAP, 10_000, "ABSOLUTE_FEE_BPS_CAP");
        assertEq(ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS, 3_000, "DEFAULT_MAX_TOTAL_FEE_BPS");
    }
}
