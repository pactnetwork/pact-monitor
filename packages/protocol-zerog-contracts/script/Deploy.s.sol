// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2}    from "forge-std/Script.sol";
import {IERC20}              from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PactCore}            from "../src/PactCore.sol";
import {MockUsdc}            from "../src/MockUsdc.sol";
import {MockUsdcFaucet}      from "../src/MockUsdcFaucet.sol";

/// @title  Pact-0G Deploy script
/// @notice Deploys MockUsdc → MockUsdcFaucet → transferOwnership →
///         PactCore. Defaults to Galileo testnet (chain 16602).
///
/// Env:
///   DEPLOYER_PK              required — private key of the broadcaster
///   ADMIN_ADDR               optional — defaults to deployer
///   SETTLER_ADDR             optional — defaults to deployer
///   TREASURY_ADDR            optional — defaults to deployer
///   FAUCET_DRIP_AMOUNT       optional — defaults to 1000e6 (1000 mUSDC)
///   FAUCET_COOLDOWN_SECONDS  optional — defaults to 86400 (24h)
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
contract Deploy is Script {
    function run() external returns (
        MockUsdc       usdc,
        MockUsdcFaucet faucet,
        PactCore       pact
    ) {
        uint256 pk          = vm.envUint("DEPLOYER_PK");
        address deployer    = vm.addr(pk);

        address admin       = _envOr("ADMIN_ADDR",     deployer);
        address settler     = _envOr("SETTLER_ADDR",   deployer);
        address treasury    = _envOr("TREASURY_ADDR",  deployer);

        uint256 dripAmount  = vm.envOr("FAUCET_DRIP_AMOUNT",      uint256(1_000e6));
        uint256 cooldown    = vm.envOr("FAUCET_COOLDOWN_SECONDS", uint256(86_400));

        console2.log("Deployer:        ", deployer);
        console2.log("Admin:           ", admin);
        console2.log("Settler:         ", settler);
        console2.log("Treasury:        ", treasury);
        console2.log("Faucet drip:     ", dripAmount);
        console2.log("Faucet cooldown: ", cooldown);

        vm.startBroadcast(pk);

        // 1. MockUsdc — deployer initially owns mint rights so tests can
        //    pre-fund accounts before ownership flips to the faucet.
        usdc = new MockUsdc(deployer);

        // 2. MockUsdcFaucet — needs the token + drip params at construction.
        faucet = new MockUsdcFaucet(usdc, dripAmount, cooldown);

        // 3. Hand mint rights to the faucet — after this, only the faucet's
        //    drip() can mint mUSDC (rate-limited per address).
        usdc.transferOwnership(address(faucet));

        // 4. PactCore — premiumToken is the now-faucet-owned mUSDC.
        pact = new PactCore(admin, settler, treasury, IERC20(address(usdc)));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployed addresses ===");
        console2.log("MockUsdc:        ", address(usdc));
        console2.log("MockUsdcFaucet:  ", address(faucet));
        console2.log("PactCore:        ", address(pact));
    }

    function _envOr(string memory key, address fallback_) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }
}
