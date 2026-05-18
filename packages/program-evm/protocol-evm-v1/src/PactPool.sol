// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPactPool} from "./interfaces/IPactPool.sol";
import {IPactRegistry} from "./interfaces/IPactRegistry.sol";
import "./errors/PactErrors.sol";

/// @title PactPool
/// @notice One-per-chain USDC coverage-pool vault, keyed by 16-byte `slug`
///         (design spec §4 #2). EVM analogue of the Solana `CoveragePool`
///         PDA. The contract custodies USDC directly (it is the ERC-20
///         holder/spender — no per-pool vault account, §4 #2).
/// @dev Behavioral port of `top_up_coverage_pool.rs` + the `CoveragePool`
///      mutations of `settle_batch.rs:360-498`. Pool exists iff the endpoint
///      is registered (`registry.isRegistered`, D1). Role model: §4 #5.
contract PactPool is IPactPool, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    IERC20 private immutable _usdc;
    IPactRegistry public immutable registry;

    mapping(bytes16 => PoolState) private _pools;

    constructor(address usdc_, address registry_) {
        _usdc = IERC20(usdc_);
        registry = IPactRegistry(registry_);
        // Protocol authority administers roles (grants SETTLER_ROLE to the
        // WP-EVM-04 settler post-deploy). registry.authority() is set once in
        // the PactRegistry constructor with no setter — effectively immutable.
        _grantRole(DEFAULT_ADMIN_ROLE, registry.authority());
    }

    function usdc() external view returns (address) {
        return address(_usdc);
    }

    /// @inheritdoc IPactPool
    /// @dev Port of top_up_coverage_pool.rs. Authority-gated (D3 — Solana
    ///      requires signer == coverage_pool.authority == register-time
    ///      ProtocolConfig.authority); slug must be registered (D1); pulls
    ///      `amount` USDC msg.sender→this; checked adds → ArithmeticOverflow
    ///      (D6, mirrors checked_add → PactError::ArithmeticOverflow).
    function topUp(bytes16 slug, uint64 amount) external override {
        if (msg.sender != registry.authority()) revert UnauthorizedAuthority();
        if (!registry.isRegistered(slug)) revert EndpointNotFound();

        _usdc.safeTransferFrom(msg.sender, address(this), amount);

        PoolState storage p = _pools[slug];
        uint64 newBal;
        uint64 newDep;
        unchecked {
            newBal = p.currentBalance + amount;
            newDep = p.totalDeposits + amount;
        }
        if (newBal < p.currentBalance) revert ArithmeticOverflow();
        if (newDep < p.totalDeposits) revert ArithmeticOverflow();
        p.currentBalance = newBal;
        p.totalDeposits = newDep;
        if (p.createdAt == 0) p.createdAt = uint64(block.timestamp);

        emit PoolToppedUp(slug, msg.sender, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev Pool exists iff endpoint registered (D1) — mirrors Solana
    ///      `top_up`'s pool-account existence requirement.
    function balanceOf(bytes16 slug) external view override returns (PoolState memory) {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        return _pools[slug];
    }

    /// @inheritdoc IPactPool
    function creditPremium(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function debitForFees(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function debitForRefund(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function payout(address, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }
}
