// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactSettler} from "../src/PactSettler.sol";
import {ArcConfig} from "../src/ArcConfig.sol";

/// @title DeploymentTest
/// @notice Trivial compile-sanity + toolchain proof for the WP-EVM-01
///         scaffold: deploys each contract, asserts it has bytecode, and
///         pins the verified Arc Testnet constants (design PR #201 §4.8.4).
/// @dev Zero-dependency on purpose — no forge-std so `forge build` /
///      `forge test` run deterministically offline. WP-EVM-06 replaces this
///      with a full forge-std + fuzz suite mirroring the LiteSVM tests.
contract DeploymentTest {
    function test_DeployPactRegistry() external {
        PactRegistry r = new PactRegistry(address(this));
        require(address(r).code.length > 0, "registry: no bytecode");
        require(r.owner() == address(this), "registry: owner not set");
    }

    function test_DeployPactPool() external {
        PactPool p = new PactPool(ArcConfig.ARC_TESTNET_USDC);
        require(address(p).code.length > 0, "pool: no bytecode");
        require(p.usdc() == ArcConfig.ARC_TESTNET_USDC, "pool: usdc not set");
    }

    function test_DeployPactSettler() external {
        PactSettler s = new PactSettler(
            ArcConfig.ARC_TESTNET_USDC,
            address(0x1), // registry placeholder (wired in WP-EVM-07)
            address(0x2), // pool placeholder
            address(this) // settler role placeholder
        );
        require(address(s).code.length > 0, "settler: no bytecode");
        require(s.usdc() == ArcConfig.ARC_TESTNET_USDC, "settler: usdc not set");
    }

    /// @dev Pins the verified Arc Testnet facts so a wrong constant fails
    ///      loudly. Live `decimals()` check against deployed USDC is
    ///      deferred — TODO(WP-EVM-06).
    function test_ArcTestnetConstants() external pure {
        require(ArcConfig.ARC_TESTNET_CHAIN_ID == 5042002, "arc: chain id");
        require(
            ArcConfig.ARC_TESTNET_USDC == 0x3600000000000000000000000000000000000000,
            "arc: usdc address"
        );
        require(ArcConfig.EXPECTED_USDC_DECIMALS == 6, "arc: usdc decimals");
    }
}
