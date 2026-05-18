// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPactPool
/// @notice Holds USDC liquidity for every insured endpoint, keyed by a
///         16-byte `slug` (design spec §4 #2). The pool contract itself
///         custodies USDC — it is the `transferFrom` receiver for premium-in
///         + topUp and the sender for fee fan-out + refund. EVM analogue of
///         the Solana `CoveragePool` PDA.
/// @dev `PoolState` mirrors `CoveragePool` mutable accounting
///      `{current_balance, total_deposits, total_premiums, total_refunds,
///      created_at}` (bump/authority/usdc_mint/usdc_vault/endpoint_slug are
///      Solana-platform layout — slug is the mapping key, the contract is the
///      vault, authority comes from PactRegistry; §4 #2/#4).
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

    // Settler-gated accounting hooks (SETTLER_ROLE, §4 #5). Mirror the
    // CoveragePool mutations of settle_batch.rs:360-498; composed by WP-EVM-04.
    function creditPremium(bytes16 slug, uint64 amount) external;
    function debitForFees(bytes16 slug, uint64 amount) external;
    function debitForRefund(bytes16 slug, uint64 amount) external;
    function payout(address to, uint64 amount) external;
}
