// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IPactRegistry} from "../src/interfaces/IPactRegistry.sol";

interface ISafeMinimal {
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);
}

/// @title ConfigureAuthority
/// @notice Phase 2 of the C-01 authority fix
///         (docs/security/arc-mainnet-predeploy-review-2026-09-24.md). After
///         `Deploy.s.sol` (Phase 1) constructs PactRegistry/PactPool/
///         PactSettler with a real multisig as `authority_`, the deployer EOA
///         holds NO admin role anywhere — every admin action from here on
///         (SETTLER_ROLE grants, endpoint registration, pool funding) MUST be
///         signed and submitted by the multisig itself via `execTransaction`.
///         This script builds each Safe transaction, signs it with 2 owner
///         keys (sorted by recovered address ascending, per Safe's
///         `checkNSignatures`), and submits it.
/// @dev Deploy-tooling ONLY — no PactRegistry/PactPool/PactSettler source is
///      touched. Uses a minimal local `ISafeMinimal` interface (matches Safe
///      v1.4.1's `Safe.sol` exactly — verified against
///      github.com/safe-global/safe-smart-account @ tag v1.4.1) instead of
///      adding a Safe contracts dependency to this repo.
///
///      For a testnet proof where every Safe owner key is one we generated
///      ourselves, it is legitimate for this script to also submit the
///      signed `execTransaction` calls — the fix being proven is that
///      `authority` is a rotatable-in-principle, multi-owner-CAPABLE contract
///      instead of a single unrotatable EOA, not that real operational
///      multi-party governance already exists (that is a separate, later,
///      human step, owned by Rick).
///
///      Sequence (6 Safe transactions, consecutive nonces on the fresh Safe):
///        1. registry.grantRole(SETTLER_ROLE, settler)
///        2. pool.grantRole(SETTLER_ROLE, settler)
///        3. settler.grantRole(SETTLER_ROLE, offChainSettlerEOA)
///        4. registry.registerEndpoint(slug, ...) — requires an explicit
///           Treasury fee recipient (kind=0, bps>0); the "empty default fee
///           template" from Deploy.s.sol means NO endpoint can ever rely on
///           defaults (finding #2, project_pact_arc_testnet_rehearsal_2026-09-24.md).
///        5. usdc.approve(pool, topUpAmount) — signed by the Safe, since
///           PactPool.topUp() pulls from msg.sender == registry.authority().
///        6. pool.topUp(slug, topUpAmount)
contract ConfigureAuthority is Script {
    bytes32 constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    struct AuthorityConfig {
        address payable safe;
        uint256 ownerAKey;
        uint256 ownerBKey;
        uint256 broadcasterKey;
        address registry;
        address pool;
        address settler;
        address usdc;
        address offChainSettler;
        address treasuryVault;
        bytes16 slug;
        uint64 flatPremium;
        uint16 percentBps;
        uint32 slaLatencyMs;
        uint64 imputedCost;
        uint64 exposureCapPerHour;
        uint16 treasuryBps;
        uint64 topUpAmount;
    }

    /// @dev Runs steps 1-4 (role grants + endpoint registration) only. Step 5
    ///      (usdc.approve) and step 6 (pool.topUp) are handled separately by
    ///      `printFundPoolCalldata()` — see that function's doc for why:
    ///      Arc's compliance precompile at
    ///      `0x1800000000000000000000000000000000000001` (`isBlocklisted`,
    ///      invoked inside Arc's USDC `transferFrom`) is not understood by
    ///      Foundry's local EVM (revm), which `forge script --broadcast`
    ///      always uses for a pre-flight dry-run simulation before it will
    ///      broadcast anything — even when `--rpc-url` points at the real
    ///      chain. That local simulation reverts with `StackUnderflow` on
    ///      this precompile regardless of whether the target is a local fork
    ///      or the real Arc testnet, so `forge script` can NEVER broadcast a
    ///      transaction that triggers it, and (per `forge script`'s
    ///      all-or-nothing semantics) a revert on ANY step in one `run()`
    ///      means NONE of that run's transactions are sent, even ones that
    ///      would have succeeded on their own. Confirmed empirically against
    ///      real `rpc.testnet.arc.io`, not just a local anvil fork.
    function run() external {
        AuthorityConfig memory cfg = _loadConfig();
        ISafeMinimal safe = ISafeMinimal(cfg.safe);

        console.log("=== ConfigureAuthority: multisig-signed Phase 2 (steps 1-4) ===");
        console.log("safe            :", cfg.safe);
        console.log("registry        :", cfg.registry);
        console.log("pool            :", cfg.pool);
        console.log("settler         :", cfg.settler);
        console.log("starting nonce  :", safe.nonce());

        vm.startBroadcast(cfg.broadcasterKey);
        _grantSettlerRoles(safe, cfg);
        _registerEndpoint(safe, cfg);
        vm.stopBroadcast();

        console.log("--- Steps 1-4 complete ---");
        console.log("nonce after     :", safe.nonce());
        console.log("NEXT: run printFundPoolCalldata() (no --broadcast) to get");
        console.log("the usdc.approve + pool.topUp calldata+signatures, then");
        console.log("submit each with a plain `cast send ... execTransaction ...`");
        console.log("(NOT forge script) so gas estimation hits the real node.");
    }

    /// @notice Prints the Safe `execTransaction` calldata + packed signatures
    ///         for steps 5 (usdc.approve) and 6 (pool.topUp), for submission
    ///         via plain `cast send` — see `run()`'s doc for why this can't
    ///         go through `forge script --broadcast` on Arc. Read-only: does
    ///         not broadcast anything itself (no `vm.startBroadcast`), so
    ///         it's safe to run with or without `--broadcast`.
    function printFundPoolCalldata() external {
        AuthorityConfig memory cfg = _loadConfig();
        ISafeMinimal safe = ISafeMinimal(cfg.safe);
        uint256 nonce = safe.nonce();
        _printApproveStep(safe, cfg, nonce);
        _printTopUpStep(safe, cfg, nonce + 1);
    }

    function _printApproveStep(ISafeMinimal safe, AuthorityConfig memory cfg, uint256 nonce) internal {
        bytes memory data = abi.encodeWithSignature("approve(address,uint256)", cfg.pool, uint256(cfg.topUpAmount));
        bytes32 txHash = safe.getTransactionHash(cfg.usdc, 0, data, 0, 0, 0, 0, address(0), address(0), nonce);
        bytes memory sigs = _sortedSignatures(cfg.ownerAKey, cfg.ownerBKey, txHash);
        _printCastSendLine("STEP 5: usdc.approve(pool, topUpAmount)", nonce, cfg.safe, cfg.usdc, data, sigs);
    }

    function _printTopUpStep(ISafeMinimal safe, AuthorityConfig memory cfg, uint256 nonce) internal {
        bytes memory data = abi.encodeWithSignature("topUp(bytes16,uint64)", cfg.slug, cfg.topUpAmount);
        bytes32 txHash = safe.getTransactionHash(cfg.pool, 0, data, 0, 0, 0, 0, address(0), address(0), nonce);
        bytes memory sigs = _sortedSignatures(cfg.ownerAKey, cfg.ownerBKey, txHash);
        _printCastSendLine("STEP 6: pool.topUp(slug, topUpAmount)", nonce, cfg.safe, cfg.pool, data, sigs);
    }

    function _printCastSendLine(
        string memory label,
        uint256 nonce,
        address safe,
        address to,
        bytes memory data,
        bytes memory sigs
    ) internal view {
        console.log(string.concat("=== ", label, " - nonce ", vm.toString(nonce), " ==="));
        console.log(
            string.concat(
                "cast send ",
                vm.toString(safe),
                " \"execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)\" ",
                vm.toString(to),
                " 0 ",
                vm.toString(data),
                " 0 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 ",
                vm.toString(sigs)
            )
        );
    }

    function _loadConfig() internal returns (AuthorityConfig memory cfg) {
        cfg.safe = payable(vm.envAddress("MULTISIG_ADDRESS"));
        cfg.ownerAKey = vm.envUint("SAFE_OWNER_A_PRIVATE_KEY");
        cfg.ownerBKey = vm.envUint("SAFE_OWNER_B_PRIVATE_KEY");
        cfg.broadcasterKey = vm.envOr("SAFE_BROADCASTER_PRIVATE_KEY", cfg.ownerAKey);

        cfg.registry = vm.envAddress("REGISTRY_ADDRESS");
        cfg.pool = vm.envAddress("POOL_ADDRESS");
        cfg.settler = vm.envAddress("SETTLER_ADDRESS");
        cfg.usdc = vm.envAddress("USDC_ADDRESS");
        cfg.offChainSettler = vm.envAddress("OFFCHAIN_SETTLER_ADDRESS");
        cfg.treasuryVault = vm.envAddress("TREASURY_VAULT_ADDRESS");

        cfg.slug = bytes16(bytes(vm.envOr("ENDPOINT_SLUG", string("dummy"))));
        cfg.flatPremium = uint64(vm.envOr("ENDPOINT_FLAT_PREMIUM", uint256(1000)));
        cfg.percentBps = uint16(vm.envOr("ENDPOINT_PERCENT_BPS", uint256(0)));
        cfg.slaLatencyMs = uint32(vm.envOr("ENDPOINT_SLA_LATENCY_MS", uint256(2000)));
        cfg.imputedCost = uint64(vm.envOr("ENDPOINT_IMPUTED_COST", uint256(10000)));
        cfg.exposureCapPerHour = uint64(vm.envOr("ENDPOINT_EXPOSURE_CAP_PER_HOUR", uint256(1000000)));
        cfg.treasuryBps = uint16(vm.envOr("ENDPOINT_TREASURY_BPS", uint256(1000)));
        cfg.topUpAmount = uint64(vm.envOr("POOL_TOPUP_AMOUNT", uint256(5000000)));
    }

    function _grantSettlerRoles(ISafeMinimal safe, AuthorityConfig memory cfg) internal {
        _execSafeTx(
            safe,
            cfg.ownerAKey,
            cfg.ownerBKey,
            cfg.registry,
            abi.encodeWithSignature("grantRole(bytes32,address)", SETTLER_ROLE, cfg.settler),
            "registry.grantRole(SETTLER_ROLE, settler)"
        );
        _execSafeTx(
            safe,
            cfg.ownerAKey,
            cfg.ownerBKey,
            cfg.pool,
            abi.encodeWithSignature("grantRole(bytes32,address)", SETTLER_ROLE, cfg.settler),
            "pool.grantRole(SETTLER_ROLE, settler)"
        );
        // Gap the first rehearsal found (finding #2): Deploy.s.sol never
        // granted SETTLER_ROLE on the PactSettler contract itself to the
        // off-chain settler EOA — only the registry+pool grants.
        _execSafeTx(
            safe,
            cfg.ownerAKey,
            cfg.ownerBKey,
            cfg.settler,
            abi.encodeWithSignature("grantRole(bytes32,address)", SETTLER_ROLE, cfg.offChainSettler),
            "settler.grantRole(SETTLER_ROLE, offChainSettler)"
        );
    }

    function _registerEndpoint(ISafeMinimal safe, AuthorityConfig memory cfg) internal {
        // Explicit Treasury fee recipient (the second rehearsal-found gap:
        // no endpoint can register on the empty default template).
        IPactRegistry.FeeRecipient[8] memory recipients;
        recipients[0] = IPactRegistry.FeeRecipient({kind: 0, destination: cfg.treasuryVault, bps: cfg.treasuryBps});
        bytes memory data = abi.encodeWithSignature(
            "registerEndpoint(bytes16,uint64,uint16,uint32,uint64,uint64,bool,uint8,(uint8,address,uint16)[8])",
            cfg.slug,
            cfg.flatPremium,
            cfg.percentBps,
            cfg.slaLatencyMs,
            cfg.imputedCost,
            cfg.exposureCapPerHour,
            true,
            uint8(1),
            recipients
        );
        _execSafeTx(safe, cfg.ownerAKey, cfg.ownerBKey, cfg.registry, data, "registry.registerEndpoint(slug, ...)");
    }

    /// @dev Builds, signs (2-of-N, sorted by recovered address ascending per
    ///      Safe's `checkNSignatures`), and submits one Safe transaction.
    ///      `safeTxGas`/`baseGas`/`gasPrice`/`gasToken`/`refundReceiver` are
    ///      all zero — no refund, the broadcaster pays real network gas
    ///      directly, exactly like any other `vm.startBroadcast` call.
    function _execSafeTx(
        ISafeMinimal safe,
        uint256 ownerAKey,
        uint256 ownerBKey,
        address to,
        bytes memory data,
        string memory label
    ) internal {
        uint256 txNonce = safe.nonce();
        bytes32 txHash = safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), txNonce);

        bytes memory signatures = _sortedSignatures(ownerAKey, ownerBKey, txHash);

        bool ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures);
        require(ok, string.concat("SAFE_EXEC_FAILED: ", label));
        console.log(string.concat("  ok  nonce=", vm.toString(txNonce), "  "), label);
    }

    function _sortedSignatures(uint256 keyA, uint256 keyB, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 vA, bytes32 rA, bytes32 sA) = vm.sign(keyA, txHash);
        (uint8 vB, bytes32 rB, bytes32 sB) = vm.sign(keyB, txHash);
        address ownerA = ecrecover(txHash, vA, rA, sA);
        address ownerB = ecrecover(txHash, vB, rB, sB);
        require(ownerA != ownerB, "SAME_SIGNER_TWICE");
        if (ownerA < ownerB) {
            return abi.encodePacked(rA, sA, vA, rB, sB, vB);
        }
        return abi.encodePacked(rB, sB, vB, rA, sA, vA);
    }
}
