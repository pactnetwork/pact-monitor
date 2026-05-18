// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ArcConfig
/// @notice Verified Arc Testnet network constants. Source: Pact Network EVM
///         expansion design PR #201 §4.8.4, checked 2026-05-15.
/// @dev WP-EVM-01 scaffold — compile-time constants only, no logic.
library ArcConfig {
    /// @notice Arc Testnet EVM chain id.
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    /// @notice Arc Testnet USDC token. USDC is Arc's native gas token; Pact
    ///         uses its 6-decimal ERC-20 interface.
    address internal constant ARC_TESTNET_USDC =
        0x3600000000000000000000000000000000000000;

    /// @notice USDC decimals Pact's premium math assumes (Solana 6-decimal
    ///         parity, design §2 / §4.8.4). 18-decimal native gas accounting
    ///         is chain-level and does not touch premium math.
    /// @dev WP-EVM-06 T8: the live `IERC20Metadata(USDC).decimals() == 6`
    ///      assertion is enforced in `test/UsdcDecimals.t.sol` (a decimals
    ///      mismatch fails loudly); the same require() guard wires into the
    ///      WP-EVM-07 deploy script.
    uint8 internal constant EXPECTED_USDC_DECIMALS = 6;

    // --- Ported from Solana constants.rs (parity invariants, design spec §3) ---
    uint16 internal constant MAX_BATCH_SIZE = 50;
    uint64 internal constant MIN_PREMIUM = 100;
    uint8 internal constant MAX_FEE_RECIPIENTS = 8;
    uint16 internal constant ABSOLUTE_FEE_BPS_CAP = 10_000;
    uint16 internal constant DEFAULT_MAX_TOTAL_FEE_BPS = 3_000;
}
