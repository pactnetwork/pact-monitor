// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPactSettler} from "./interfaces/IPactSettler.sol";

/// @title PactSettler
/// @notice One-per-chain settlement executor (design PR #201 §3.3). Holds the
///         settler role; for each call in a batch it pulls the premium from
///         the agent via `transferFrom`, credits the pool, fans out fees to
///         the registry's fee recipients, and pays the refund on SLA breach.
///         Kept separate from `PactPool` per the §3.3 recommendation (settler
///         holds the role; pool holds the money).
/// @dev WP-EVM-01 SCAFFOLD. Storage layout, events and signatures only;
///      `settleBatch` reverts `NOT_IMPLEMENTED`. Real logic ports in
///      WP-EVM-04/05 from `settle_batch.rs` (premium-in, fee fan-out,
///      on-breach refund, exposure cap, packed-bitmap dedup).
contract PactSettler is IPactSettler {
    /// @notice USDC token (6-decimal ERC-20 interface). Premium-in and refund
    ///         settle in this asset; on Arc it is also the gas token.
    address public immutable usdc;

    /// @notice Registry that owns endpoint config + fee-recipient policy.
    address public immutable registry;

    /// @notice Pool that custodies endpoint liquidity.
    address public immutable pool;

    /// @notice Address authorised to call `settleBatch` (the settler role).
    /// @dev TODO(WP-EVM-05): replace with OpenZeppelin AccessControl
    ///      `SETTLER_ROLE`.
    address public settler;

    constructor(address usdc_, address registry_, address pool_, address settler_) {
        usdc = usdc_;
        registry = registry_;
        pool = pool_;
        settler = settler_;
    }

    /// @inheritdoc IPactSettler
    function settleBatch(SettlementEvent[] calldata) external override {
        revert("NOT_IMPLEMENTED");
    }
}
