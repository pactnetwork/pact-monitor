// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPactSettler} from "./interfaces/IPactSettler.sol";
import {IPactPool} from "./interfaces/IPactPool.sol";
import {IPactRegistry} from "./interfaces/IPactRegistry.sol";

/// @title PactSettler
/// @notice One-per-chain settlement executor (design PR #201 §3.3). Holds the
///         settler role; for each call in a batch it pulls the premium from
///         the agent via `transferFrom`, credits the pool, fans out fees to
///         the registry's fee recipients, and pays the refund on SLA breach.
///         Kept separate from `PactPool` per the §3.3 recommendation (settler
///         holds the role; pool holds the money).
/// @dev WP-EVM-04 — AccessControl SETTLER_ROLE per GATE-A ruling on E2.
///      ctor: 3-arg (drop `address settler_`); DEFAULT_ADMIN_ROLE ->
///      registry.authority() (exact PactPool pattern). Deployed PactSettler
///      must hold SETTLER_ROLE on BOTH PactPool AND PactRegistry (E1xE2
///      two-layer grant wired in test setUp + deployment).
///      settleBatch logic ports in plans 03/04.
contract PactSettler is IPactSettler, AccessControl {
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    /// @notice USDC token (6-decimal ERC-20 interface). Premium-in and refund
    ///         settle in this asset; on Arc it is also the gas token.
    address public immutable usdc;

    /// @notice Registry that owns endpoint config + fee-recipient policy.
    IPactRegistry public immutable registry;

    /// @notice Pool that custodies endpoint liquidity.
    IPactPool public immutable pool;

    /// @dev settle_batch.rs:396-399 — 3-arg ctor, DEFAULT_ADMIN_ROLE ->
    ///      registry.authority() (mirrors PactPool.sol:35).
    constructor(address usdc_, address registry_, address pool_) {
        usdc = usdc_;
        registry = IPactRegistry(registry_);
        pool = IPactPool(pool_);
        // Protocol authority administers roles (grants SETTLER_ROLE to
        // authorised settler signers post-deploy). registry.authority() is
        // set once in the PactRegistry constructor — effectively immutable.
        _grantRole(DEFAULT_ADMIN_ROLE, IPactRegistry(registry_).authority());
    }

    /// @inheritdoc IPactSettler
    /// @dev SETTLER_ROLE-gated (SET-01). Logic ports in plans 03/04.
    function settleBatch(SettlementEvent[] calldata) external override onlyRole(SETTLER_ROLE) {
        revert("NOT_IMPLEMENTED");
    }
}
