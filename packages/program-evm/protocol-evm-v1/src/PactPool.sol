// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPactPool} from "./interfaces/IPactPool.sol";

/// @title PactPool
/// @notice One-per-chain USDC liquidity vault holding every endpoint's
///         coverage pool, keyed by 16-byte `slug` (design PR #201 §3.2,
///         §3.4). This contract address is the `transferFrom` receiver for
///         premium-in and the sender for fee fan-out + refund. EVM analogue
///         of the Solana `CoveragePool` PDA.
/// @dev WP-EVM-01 SCAFFOLD. Storage layout, events and signatures only;
///      `topUp` reverts `NOT_IMPLEMENTED`. Real logic ports in WP-EVM-03 from
///      `top_up_coverage_pool.rs` + the `CoveragePool` state.
contract PactPool is IPactPool {
    /// @notice USDC token this pool holds (6-decimal ERC-20 interface).
    /// @dev On Arc, USDC is also the native gas token (design §4.8.4); the
    ///      6-decimal app interface is what premium math uses.
    address public immutable usdc;

    /// @notice slug => per-endpoint pool accounting.
    mapping(bytes16 => PoolState) internal _pools;

    constructor(address usdc_) {
        usdc = usdc_;
    }

    /// @inheritdoc IPactPool
    function topUp(bytes16, uint64) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactPool
    function balanceOf(bytes16) external view override returns (PoolState memory) {
        revert("NOT_IMPLEMENTED");
    }
}
