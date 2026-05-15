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
    /// @dev TODO(WP-EVM-06): assert `IERC20(ARC_TESTNET_USDC).decimals() == 6`
    ///      against a forked/mock USDC so a decimals mismatch fails loudly.
    uint8 internal constant EXPECTED_USDC_DECIMALS = 6;
}
