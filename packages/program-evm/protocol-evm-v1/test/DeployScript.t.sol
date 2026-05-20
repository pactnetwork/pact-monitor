// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";

/// @title DeployScript chains.json resolution test
/// @notice Direct unit test of the chain-lookup pattern used in
///         script/Deploy.s.sol. Proves the chains.json read + cross-check
///         logic works without actually broadcasting.
contract DeployScriptTest is Test {
    function test_ResolvesArcTestnetFromChainsJson() public {
        string memory j = vm.readFile("config/chains.json");
        string[] memory names = vm.parseJsonKeys(j, ".");

        // arc-testnet must be present.
        bool found = false;
        for (uint256 i = 0; i < names.length; i++) {
            if (keccak256(bytes(names[i])) == keccak256(bytes("arc-testnet"))) {
                found = true;
                break;
            }
        }
        require(found, "arc-testnet missing from chains.json");

        uint256 cid = vm.parseJsonUint(j, ".arc-testnet.chainId");
        address usdc = vm.parseJsonAddress(j, ".arc-testnet.usdcAddress");
        uint256 dec = vm.parseJsonUint(j, ".arc-testnet.usdcDecimals");

        assertEq(cid, 5042002, "chainId");
        assertEq(usdc, 0x3600000000000000000000000000000000000000, "usdc");
        assertEq(dec, ProtocolInvariants.EXPECTED_USDC_DECIMALS, "decimals invariant");
    }

    function test_UnknownChainIdHasNoEntry() public {
        string memory j = vm.readFile("config/chains.json");
        string[] memory names = vm.parseJsonKeys(j, ".");
        for (uint256 i = 0; i < names.length; i++) {
            uint256 cid = vm.parseJsonUint(
                j,
                string.concat(".", names[i], ".chainId")
            );
            assertTrue(cid != 9999999, "9999999 must not be in chains.json");
        }
    }
}
