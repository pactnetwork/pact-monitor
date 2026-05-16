// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2}    from "forge-std/Script.sol";
import {IERC20}              from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PactCore}            from "../src/PactCore.sol";
import {MockUsdc}            from "../src/MockUsdc.sol";
import {MockUsdcFaucet}      from "../src/MockUsdcFaucet.sol";

/// @title  Pact-0G Deploy script
/// @notice Deploys PactCore against a premium token (USDC). Two modes:
///
///         1. Real-USDC mode (mainnet / Aristotle 16661):
///            USDC_ADDR is set, or chain id is 16661 and no override given —
///            PactCore wires to the canonical XSwap Bridged USDC at
///            0x1f3aa82227281ca364bfb3d253b0f1af1da6473e. No mock, no faucet.
///         2. Mock-USDC mode (testnet / Galileo 16602):
///            USDC_ADDR unset and chain id != 16661 — deploys MockUsdc +
///            MockUsdcFaucet, hands mint rights to the faucet, then PactCore.
///
/// Env:
///   DEPLOYER_PK              required — private key of the broadcaster
///   USDC_ADDR                optional — explicit premium-token address;
///                            overrides chain-id detection
///   ADMIN_ADDR               optional — defaults to deployer
///   SETTLER_ADDR             optional — defaults to deployer
///   TREASURY_ADDR            optional — defaults to deployer
///   FAUCET_DRIP_AMOUNT       optional (mock mode only) — defaults to 1000e6
///   FAUCET_COOLDOWN_SECONDS  optional (mock mode only) — defaults to 86400
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
contract Deploy is Script {
    /// XSwap Bridged USDC (USDC.e), 6 decimals — verified on Aristotle RPC
    /// 2026-05-16. Chainlink CCIP token, ~1.7M supply at hackathon submission.
    /// Source: https://www.coingecko.com/en/coins/xswap-bridged-usdc-0g
    address internal constant ARISTOTLE_USDC = 0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E;
    uint256 internal constant ARISTOTLE_CHAIN_ID = 16661;

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

        // Resolve premium token: explicit USDC_ADDR > Aristotle default > mock.
        address premiumToken = _envOr("USDC_ADDR", address(0));
        if (premiumToken == address(0) && block.chainid == ARISTOTLE_CHAIN_ID) {
            premiumToken = ARISTOTLE_USDC;
        }
        bool useRealUsdc = premiumToken != address(0);

        console2.log("Chain ID:        ", block.chainid);
        console2.log("Deployer:        ", deployer);
        console2.log("Admin:           ", admin);
        console2.log("Settler:         ", settler);
        console2.log("Treasury:        ", treasury);
        console2.log("Real USDC mode:  ", useRealUsdc);

        vm.startBroadcast(pk);

        if (useRealUsdc) {
            // Mainnet path: skip mock + faucet, point straight at real USDC.
            pact = new PactCore(admin, settler, treasury, IERC20(premiumToken));
        } else {
            uint256 dripAmount = vm.envOr("FAUCET_DRIP_AMOUNT",      uint256(1_000e6));
            uint256 cooldown   = vm.envOr("FAUCET_COOLDOWN_SECONDS", uint256(86_400));

            console2.log("Faucet drip:     ", dripAmount);
            console2.log("Faucet cooldown: ", cooldown);

            usdc   = new MockUsdc(deployer);
            faucet = new MockUsdcFaucet(usdc, dripAmount, cooldown);
            usdc.transferOwnership(address(faucet));
            pact   = new PactCore(admin, settler, treasury, IERC20(address(usdc)));
            premiumToken = address(usdc);
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployed addresses ===");
        if (useRealUsdc) {
            console2.log("PremiumToken:    ", premiumToken, "(real, not deployed by this run)");
        } else {
            console2.log("MockUsdc:        ", address(usdc));
            console2.log("MockUsdcFaucet:  ", address(faucet));
        }
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
