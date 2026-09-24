// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title DeploySafeAuthority
/// @notice Deploy-tooling ONLY (not part of the locked PactRegistry/PactPool/
///         PactSettler contract set). Deploys a fresh Safe{Wallet} multisig
///         on Arc via Safe's own canonical CREATE2 infrastructure, to serve
///         as `authority_` for a Pact deploy (fixes C-01 in
///         docs/security/arc-mainnet-predeploy-review-2026-09-24.md — a
///         single non-rotatable EOA authority with no rotation path).
/// @dev Canonical Safe v1.4.1 addresses below are IDENTICAL across every EVM
///      chain that has the Safe Singleton Factory (deterministic CREATE2
///      deployer) — confirmed independently deployed (real bytecode, not
///      just listed in safe-deployments) on Arc TESTNET (5042002) via
///      `eth_getCode` against `rpc.testnet.arc.io` on 2026-09-24:
///        Safe Singleton Factory : 0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7
///        SafeProxyFactory v1.4.1: 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
///        SafeL2 v1.4.1 singleton: 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
///      SafeL2 (not plain Safe) is used deliberately — Safe's own guidance is
///      to use the L2 variant on any chain other than Ethereum mainnet, since
///      it emits explicit events for every state change instead of relying on
///      trace-based indexing. This matters extra on Arc: the same rehearsal
///      that motivated this fix already found `eth_getLogs` retention pruning
///      on Arc testnet (project_pact_arc_testnet_rehearsal_2026-09-24.md).
///      No fallback handler is set (address(0)) — this Safe only needs to
///      hold/approve USDC and call `execTransaction`; it never needs
///      `isValidSignature` or token-received callbacks for this use case.
contract DeploySafeAuthority is Script {
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    function run() external returns (address safe) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner1 = vm.envAddress("SAFE_OWNER_1");
        address owner2 = vm.envAddress("SAFE_OWNER_2");
        address owner3 = vm.envAddress("SAFE_OWNER_3");
        uint256 threshold = vm.envOr("SAFE_THRESHOLD", uint256(2));
        uint256 saltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(1));

        require(SAFE_PROXY_FACTORY.code.length > 0, "SAFE_PROXY_FACTORY_NOT_DEPLOYED_ON_THIS_CHAIN");
        require(SAFE_L2_SINGLETON.code.length > 0, "SAFE_L2_SINGLETON_NOT_DEPLOYED_ON_THIS_CHAIN");
        require(owner1 != owner2 && owner2 != owner3 && owner1 != owner3, "DUPLICATE_SAFE_OWNER");
        require(threshold >= 1 && threshold <= 3, "THRESHOLD_OUT_OF_RANGE");

        address[] memory owners = new address[](3);
        owners[0] = owner1;
        owners[1] = owner2;
        owners[2] = owner3;

        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            threshold,
            address(0),
            bytes(""),
            address(0),
            address(0),
            uint256(0),
            address(0)
        );

        console.log("=== Deploying Safe authority multisig on Arc ===");
        console.log("owner 1  :", owner1);
        console.log("owner 2  :", owner2);
        console.log("owner 3  :", owner3);
        console.log("threshold:", threshold);

        vm.startBroadcast(deployerKey);
        (bool ok, bytes memory ret) = SAFE_PROXY_FACTORY.call(
            abi.encodeWithSignature(
                "createProxyWithNonce(address,bytes,uint256)", SAFE_L2_SINGLETON, initializer, saltNonce
            )
        );
        require(ok, "SAFE_PROXY_CREATE_FAILED");
        vm.stopBroadcast();

        safe = abi.decode(ret, (address));
        console.log("--- DEPLOYED ---");
        console.log("Safe (authority):", safe);
    }
}
