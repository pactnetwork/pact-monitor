// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPactPool
/// @notice Holds USDC liquidity for every insured endpoint, keyed by a
///         16-byte `slug`. The pool contract address is the `transferFrom`
///         receiver for premium-in and the sender for fee fan-out + refund.
/// @dev Shape mirrors the design sketch in PR #201 §3.2. EVM analogue of the
///      Solana `CoveragePool` PDA. WP-EVM-01 scaffold: signatures/events only.
interface IPactPool {
    /// @notice Per-endpoint pool accounting. Amounts are 6-decimal USDC.
    struct PoolState {
        uint64 currentBalance;
        uint64 totalDeposits;
        uint64 totalPremiums;
        uint64 totalRefunds;
        uint64 createdAt;
    }

    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint64 amount);

    function topUp(bytes16 slug, uint64 amount) external;

    function balanceOf(bytes16 slug) external view returns (PoolState memory);
}
