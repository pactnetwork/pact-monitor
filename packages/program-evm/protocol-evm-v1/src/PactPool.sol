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

    /// @dev Checked add mirroring Solana `checked_add → ArithmeticOverflow`.
    function _ckAdd(uint64 a, uint64 b) private pure returns (uint64 c) {
        unchecked {
            c = a + b;
        }
        if (c < a) revert ArithmeticOverflow();
    }

    /// @dev Checked sub mirroring Solana `checked_sub → ArithmeticOverflow`.
    function _ckSub(uint64 a, uint64 b) private pure returns (uint64 c) {
        if (b > a) revert ArithmeticOverflow();
        unchecked {
            c = a - b;
        }
    }

    /// @inheritdoc IPactPool
    /// @dev settle_batch.rs:360-368 — current_balance += p; total_premiums += p.
    function creditPremium(bytes16 slug, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        PoolState storage p = _pools[slug];
        p.currentBalance = _ckAdd(p.currentBalance, amount);
        p.totalPremiums = _ckAdd(p.totalPremiums, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev settle_batch.rs:448-453 — current_balance -= total_fee_paid.
    function debitForFees(bytes16 slug, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        PoolState storage p = _pools[slug];
        p.currentBalance = _ckSub(p.currentBalance, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev settle_batch.rs:481-490 — current_balance -= r; total_refunds += r.
    function debitForRefund(bytes16 slug, uint64 amount)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        if (!registry.isRegistered(slug)) revert EndpointNotFound();
        PoolState storage p = _pools[slug];
        p.currentBalance = _ckSub(p.currentBalance, amount);
        p.totalRefunds = _ckAdd(p.totalRefunds, amount);
    }

    /// @inheritdoc IPactPool
    /// @dev USDC egress for fee fan-out + refund (the SPL transfers
    ///      settle_batch.rs performs). Composed by WP-EVM-04.
    function payout(address to, uint64 amount) external override onlyRole(SETTLER_ROLE) {
        _usdc.safeTransfer(to, amount);
    }
}
