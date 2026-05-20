// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactSettler} from "../src/PactSettler.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";

/// @title DeploymentTest
/// @notice Trivial compile-sanity + toolchain proof for the WP-EVM-01
///         scaffold: deploys each contract, asserts it has bytecode, and
///         pins the verified Arc Testnet constants (design PR #201 §4.8.4).
/// @dev Zero-dependency on purpose — no forge-std so `forge build` /
///      `forge test` run deterministically offline. WP-EVM-06 replaces this
///      with a full forge-std + fuzz suite mirroring the LiteSVM tests.
contract DeploymentTest {
    function test_DeployPactRegistry() external {
        // WP-EVM-02 finalized the constructor (§4 #6 collapses the 3
        // initialize_* instructions). count == 0 default template is allowed
        // (initialize_protocol_config.rs:138), so the constructor accepts an
        // empty template here.
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), ProtocolInvariants.ARC_TESTNET_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        require(address(r).code.length > 0, "registry: no bytecode");
        require(r.authority() == address(this), "registry: authority not set");
    }

    function test_DeployPactPool() external {
        // WP-EVM-03 added the registry reference (§4 #2 pool-existence model).
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), ProtocolInvariants.ARC_TESTNET_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        PactPool p = new PactPool(ProtocolInvariants.ARC_TESTNET_USDC, address(r));
        require(address(p).code.length > 0, "pool: no bytecode");
        require(p.usdc() == ProtocolInvariants.ARC_TESTNET_USDC, "pool: usdc not set");
    }

    function test_DeployPactSettler() external {
        // WP-EVM-04: 3-arg ctor per GATE-A E2 ruling (drop address settler_,
        // DEFAULT_ADMIN_ROLE -> registry.authority()). Registry + pool wired
        // identically to test_DeployPactPool.
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), ProtocolInvariants.ARC_TESTNET_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        PactPool p = new PactPool(ProtocolInvariants.ARC_TESTNET_USDC, address(r));
        PactSettler s = new PactSettler(
            ProtocolInvariants.ARC_TESTNET_USDC,
            address(r),
            address(p)
        );
        require(address(s).code.length > 0, "settler: no bytecode");
        require(s.usdc() == ProtocolInvariants.ARC_TESTNET_USDC, "settler: usdc not set");
    }

    /// @dev Pins the verified Arc Testnet facts so a wrong constant fails
    ///      loudly. Live `decimals()` check against deployed USDC is
    ///      deferred — TODO(WP-EVM-06).
    function test_ArcTestnetConstants() external pure {
        require(ProtocolInvariants.ARC_TESTNET_CHAIN_ID == 5042002, "arc: chain id");
        require(
            ProtocolInvariants.ARC_TESTNET_USDC == 0x3600000000000000000000000000000000000000,
            "arc: usdc address"
        );
        require(ProtocolInvariants.EXPECTED_USDC_DECIMALS == 6, "arc: usdc decimals");
    }
}
