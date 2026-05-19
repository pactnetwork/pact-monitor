// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ArcConfig} from "../src/ArcConfig.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";
import {PactRegistry} from "../src/PactRegistry.sol";
import {PactPool} from "../src/PactPool.sol";
import {PactSettler} from "../src/PactSettler.sol";

/// @title Deploy
/// @notice WP-EVM-07 Arc Testnet rollout. Deploys the three LOCKED contracts
///         (PactRegistry, PactPool, PactSettler) in dependency order, wires
///         the SETTLER_ROLE grants, and asserts the live USDC decimals before
///         anything is constructed.
/// @dev Deploy script ONLY — no contract source is edited (contracts LOCKED
///      WP-02..05; WP-06 added zero behavior). Replaces the WP-EVM-01 stub.
///
///      C1 (captain GATE A verdict): `authority_` IS the deployer EOA, full
///      stop. The post-deploy SETTLER_ROLE grants are issued BY the deployer
///      and only succeed if deployer == registry.authority() (deployer holds
///      DEFAULT_ADMIN_ROLE via PactRegistry.sol:68 / PactPool.sol:35). A
///      separate/rotated authority is OUT OF SCOPE for WP-07 (later mainnet
///      authority-rotation concern, a post-deploy transfer step, not a ctor
///      arg). There is intentionally NO separate-authority branch here.
///
///      C2 (captain GATE A verdict): `treasuryVault` and `maxTotalFeeBps`
///      have NO setter — permanent for the life of the deployment. The
///      TREASURY_VAULT_ADDRESS env value and the EMPTY default fee template
///      (defaultCount_ = 0) MUST be ratified in writing by Rick/Alan BEFORE
///      broadcast (consolidated STOP-AND-ASK). This script rejects
///      address(0) for the treasury vault as a defense-in-depth backstop;
///      the human ratification remains the primary control.
contract Deploy is Script {
    function run() external {
        // --- Resolve deploy parameters from env ---
        // DEPLOYER_PRIVATE_KEY: hex (0x) private key of the Arc Testnet
        // deployer EOA. This EOA is BOTH the broadcaster AND the protocol
        // authority (C1). It must hold faucet USDC for gas.
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // TREASURY_VAULT_ADDRESS: immutable post-deploy (C2). A wrong value
        // means a full redeploy. address(0) is rejected as a backstop —
        // human ratification (C2) is still required and primary.
        address treasuryVault = vm.envAddress("TREASURY_VAULT_ADDRESS");
        require(treasuryVault != address(0), "TREASURY_VAULT_ZERO");

        address usdc = ArcConfig.ARC_TESTNET_USDC;

        // --- USDC-decimals guard (handoff (c); same require() shape as
        //     test/UsdcDecimals.t.sol). FIRST action before any construction
        //     so a wrong-decimals USDC fails the deploy loudly with zero
        //     contracts deployed. ---
        require(
            IERC20Metadata(usdc).decimals() == ArcConfig.EXPECTED_USDC_DECIMALS,
            "USDC_DECIMALS_MISMATCH"
        );

        console.log("=== WP-EVM-07 Arc Testnet deploy ===");
        console.log("chain id        :", block.chainid);
        console.log("deployer/auth   :", deployer);
        console.log("usdc            :", usdc);
        console.log("treasury vault  :", treasuryVault);
        console.log("maxTotalFeeBps  :", uint256(ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS));
        console.log("default fee tmpl : EMPTY (defaultCount_=0) [C2 ratified]");

        // EMPTY default fee template (C2 #3): defaultRecipients_ all-zero,
        // defaultCount_ = 0. Parity-valid (initialize_protocol_config.rs:
        // 138-156 — count == 0 allowed). Every endpoint registered on this
        // deployment then declares its OWN fee recipients.
        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        uint8 defaultCount = 0;

        vm.startBroadcast(deployerKey);

        // 1. PactRegistry — authority_ := deployer (C1).
        PactRegistry registry = new PactRegistry(
            deployer,
            usdc,
            treasuryVault,
            ArcConfig.DEFAULT_MAX_TOTAL_FEE_BPS,
            emptyDefaults,
            defaultCount
        );

        // 2. PactPool — needs the registry address.
        PactPool pool = new PactPool(usdc, address(registry));

        // 3. PactSettler — needs registry + pool addresses.
        PactSettler settler =
            new PactSettler(usdc, address(registry), address(pool));

        // SETTLER_ROLE grants: deployer holds DEFAULT_ADMIN_ROLE on BOTH
        // registry and pool (== registry.authority() == deployer, C1), so
        // these grants succeed. PactSettler must hold SETTLER_ROLE on BOTH.
        bytes32 settlerRole = keccak256("SETTLER_ROLE");
        registry.grantRole(settlerRole, address(settler));
        pool.grantRole(settlerRole, address(settler));

        vm.stopBroadcast();

        // --- Deployed addresses (capture for addresses.ts + Gate B) ---
        console.log("--- DEPLOYED ---");
        console.log("PactRegistry    :", address(registry));
        console.log("PactPool        :", address(pool));
        console.log("PactSettler     :", address(settler));
        console.log("SETTLER_ROLE granted to settler on registry + pool: true");
    }
}
