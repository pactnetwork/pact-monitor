// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactSettler} from "../src/PactSettler.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";

/// @title DeploymentTest
/// @notice Trivial compile-sanity + toolchain proof for the WP-EVM-01
///         scaffold: deploys each contract, asserts it has bytecode, and
///         pins the verified Arc Testnet constants (design PR #201 §4.8.4).
/// @dev Inherits forge-std Test for vm.readFile / vm.parseJson* access
///      (chains.json drift check in test_ArcTestnetConstants below). The
///      full fuzz + parity test battery for these contracts lives in the
///      sibling test files (PactRegistry.t.sol, PactPool.t.sol, etc.).
contract DeploymentTest is Test {
    // Mirror of chains.json arc-testnet entry. Drift caught by
    // test_ArcTestnetConstants below.
    address constant _ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant _ARC_CHAIN_ID = 5042002;

    function test_DeployPactRegistry() external {
        // WP-EVM-02 finalized the constructor (§4 #6 collapses the 3
        // initialize_* instructions). count == 0 default template is allowed
        // (initialize_protocol_config.rs:138), so the constructor accepts an
        // empty template here.
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), _ARC_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        require(address(r).code.length > 0, "registry: no bytecode");
        require(r.authority() == address(this), "registry: authority not set");
    }

    function test_DeployPactPool() external {
        // WP-EVM-03 added the registry reference (§4 #2 pool-existence model).
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), _ARC_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        PactPool p = new PactPool(_ARC_USDC, address(r));
        require(address(p).code.length > 0, "pool: no bytecode");
        require(p.usdc() == _ARC_USDC, "pool: usdc not set");
    }

    function test_DeployPactSettler() external {
        // WP-EVM-04: 3-arg ctor per GATE-A E2 ruling (drop address settler_,
        // DEFAULT_ADMIN_ROLE -> registry.authority()). Registry + pool wired
        // identically to test_DeployPactPool.
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        PactRegistry r = new PactRegistry(
            address(this), _ARC_USDC, address(0x1), 3000, emptyDefaults, 0
        );
        PactPool p = new PactPool(_ARC_USDC, address(r));
        PactSettler s = new PactSettler(
            _ARC_USDC,
            address(r),
            address(p)
        );
        require(address(s).code.length > 0, "settler: no bytecode");
        require(s.usdc() == _ARC_USDC, "settler: usdc not set");
    }

    /// @dev Cross-checks the local mirror constants against chains.json so
    ///      drift fails loudly. Live `decimals()` check against deployed USDC
    ///      is deferred — TODO(WP-EVM-06).
    function test_ArcTestnetConstants() external {
        // Read directly from chains.json; this test IS the cross-check that
        // the literals in this file mirror the JSON.
        string memory j = vm.readFile("config/chains.json");
        uint256 chainId = vm.parseJsonUint(j, ".arc-testnet.chainId");
        address usdc = vm.parseJsonAddress(j, ".arc-testnet.usdcAddress");
        require(chainId == _ARC_CHAIN_ID, "arc: chain id drift");
        require(usdc == _ARC_USDC, "arc: usdc drift");
        require(ProtocolInvariants.EXPECTED_USDC_DECIMALS == 6, "arc: usdc decimals");
    }
}
