// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ProtocolInvariants} from "../src/ProtocolInvariants.sol";
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
///      WP-MN-01 generalized chain selection: the script now reads
///      config/chains.json via vm.parseJsonKeys iteration keyed on
///      CHAIN_ID env (defaults to block.chainid). The USDC-decimals
///      guard remains in the exact position WP-EVM-07 placed it; a
///      new invariant cross-check (chains.json usdcDecimals ==
///      ProtocolInvariants.EXPECTED_USDC_DECIMALS) precedes it.
///
///      C1-SUPERSEDED (2026-09-24 authority fix, see
///      docs/security/arc-mainnet-predeploy-review-2026-09-24.md C-01): the
///      original C1 ruling made `authority_` the deployer EOA with no
///      rotation path — a single leaked key could drain any endpoint's pool.
///      `authority_` is now a REQUIRED env-provided address (`MULTISIG_ADDRESS`)
///      that MUST already be a deployed contract (checked below) — in
///      practice a Safe multisig. The deployer EOA no longer receives
///      DEFAULT_ADMIN_ROLE on any of the three contracts (PactRegistry grants
///      it to `authority_` in its constructor; PactPool/PactSettler grant it
///      to `registry.authority()`, which is now the multisig from the very
///      first block). Phase 2 (the SETTLER_ROLE grants, endpoint
///      registration, and pool funding) moved to `script/ConfigureAuthority.s.sol`,
///      which must be executed BY the multisig itself — the deployer EOA no
///      longer holds admin on any contract and cannot perform that setup.
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
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address treasuryVault = vm.envAddress("TREASURY_VAULT_ADDRESS");
        require(treasuryVault != address(0), "TREASURY_VAULT_ZERO");

        // --- C-01 fix: authority_ MUST be a real multisig contract, never
        // the deployer EOA and never any other bare EOA. vm.envAddress
        // reverts loudly if MULTISIG_ADDRESS is unset (no silent fallback).
        // The code-length check is defense-in-depth: it can't verify the
        // contract IS a properly configured Safe, but it guarantees whoever
        // deploys can't accidentally (or quietly) pass an EOA and reintroduce
        // the exact vulnerability this fix closes.
        address multisigAuthority = vm.envAddress("MULTISIG_ADDRESS");
        require(multisigAuthority.code.length > 0, "MULTISIG_AUTHORITY_MUST_BE_CONTRACT");

        // --- Resolve chain entry from config/chains.json ---
        uint256 chainId = vm.envOr("CHAIN_ID", uint256(block.chainid));
        string memory chainsJson = vm.readFile("config/chains.json");
        string[] memory names = vm.parseJsonKeys(chainsJson, ".");
        string memory chainName;
        for (uint256 i = 0; i < names.length; i++) {
            uint256 cid = vm.parseJsonUint(
                chainsJson,
                string.concat(".", names[i], ".chainId")
            );
            if (cid == chainId) {
                chainName = names[i];
                break;
            }
        }
        require(
            bytes(chainName).length > 0,
            string.concat("CHAIN_ID ", vm.toString(chainId), " not in chains.json")
        );

        address usdc = vm.parseJsonAddress(
            chainsJson,
            string.concat(".", chainName, ".usdcAddress")
        );
        uint256 expectedDecimals = vm.parseJsonUint(
            chainsJson,
            string.concat(".", chainName, ".usdcDecimals")
        );

        // Cross-check: chains.json claims about USDC decimals must match the
        // protocol-wide invariant (else the deploy is wrong-chain-data).
        require(
            expectedDecimals == ProtocolInvariants.EXPECTED_USDC_DECIMALS,
            "CHAIN_USDC_DECIMALS_MISMATCH_INVARIANT"
        );

        // --- Live USDC-decimals guard (preserved from pre-WP-MN-01) ---
        require(
            IERC20Metadata(usdc).decimals() == ProtocolInvariants.EXPECTED_USDC_DECIMALS,
            "USDC_DECIMALS_MISMATCH"
        );

        console.log("=== Pact EVM deploy ===");
        console.log("chain id        :", chainId);
        console.log("chain name      :", chainName);
        console.log("deployer (EOA)  :", deployer);
        console.log("authority (msig):", multisigAuthority);
        console.log("usdc            :", usdc);
        console.log("treasury vault  :", treasuryVault);
        console.log("maxTotalFeeBps  :", uint256(ProtocolInvariants.DEFAULT_MAX_TOTAL_FEE_BPS));
        console.log("default fee tmpl : EMPTY (defaultCount_=0) [C2 ratified]");

        IPactRegistry.FeeRecipient[8] memory emptyDefaults;
        uint8 defaultCount = 0;

        vm.startBroadcast(deployerKey);

        PactRegistry registry = new PactRegistry(
            multisigAuthority, usdc, treasuryVault,
            ProtocolInvariants.DEFAULT_MAX_TOTAL_FEE_BPS,
            emptyDefaults, defaultCount
        );
        PactPool pool = new PactPool(usdc, address(registry));
        PactSettler settler =
            new PactSettler(usdc, address(registry), address(pool));

        vm.stopBroadcast();

        // No SETTLER_ROLE grants here: the deployer EOA holds no admin role
        // on any of the three contracts (registry.authority() == the
        // multisig, set above). Run script/ConfigureAuthority.s.sol — signed
        // and broadcast by the multisig itself — to grant SETTLER_ROLE,
        // register endpoints, and fund pools.
        console.log("--- DEPLOYED ---");
        console.log("PactRegistry    :", address(registry));
        console.log("PactPool        :", address(pool));
        console.log("PactSettler     :", address(settler));
        console.log("authority()     :", registry.authority());
        console.log("NEXT: run ConfigureAuthority.s.sol via the multisig to grant SETTLER_ROLE + register endpoints.");
    }
}
