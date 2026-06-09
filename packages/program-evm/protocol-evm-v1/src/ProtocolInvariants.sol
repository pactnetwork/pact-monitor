// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ProtocolInvariants
/// @notice Protocol-wide constants for the Pact EVM rails. Bit-identical to
///         the Solana `pact-network-v1-pinocchio/src/constants.rs` (design
///         spec §3). Chain-specific values (chain id, USDC address) live in
///         `config/chains.json`.
library ProtocolInvariants {
    /// @notice USDC decimals Pact's premium math assumes (protocol-wide,
    ///         Solana 6-decimal parity). The deploy-script guard at
    ///         Deploy.s.sol asserts the live USDC.decimals() equals this.
    uint8 internal constant EXPECTED_USDC_DECIMALS = 6;

    // --- Protocol parity invariants (design spec §3) ---
    uint16 internal constant MAX_BATCH_SIZE = 50;
    uint64 internal constant MIN_PREMIUM = 100;
    uint8 internal constant MAX_FEE_RECIPIENTS = 8;
    uint16 internal constant ABSOLUTE_FEE_BPS_CAP = 10_000;
    uint16 internal constant DEFAULT_MAX_TOTAL_FEE_BPS = 3_000;
}
