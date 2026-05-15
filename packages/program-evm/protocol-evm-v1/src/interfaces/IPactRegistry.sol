// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPactRegistry
/// @notice Endpoint registry, fee-recipient policy, protocol config and the
///         protocol kill switch. EVM analogue of the Solana `EndpointConfig`
///         + `ProtocolConfig` PDAs.
/// @dev Shape mirrors the design sketch in PR #201 §3.1. WP-EVM-01 scaffold:
///      signatures/events only — no logic. Stats fields on `EndpointConfig`
///      are intentionally omitted here and added in WP-EVM-02 (mirror
///      `pact-network-v1-pinocchio` `state.rs` `EndpointConfig`).
interface IPactRegistry {
    /// @notice One fee-split destination. `kind`: 0 = Treasury,
    ///         1 = AffiliateAta, 2 = AffiliatePda. `bps` is basis points.
    struct FeeRecipient {
        uint8 kind;
        address destination;
        uint16 bps;
    }

    /// @notice Per-endpoint protocol config. `slug` is a 16-byte endpoint id,
    ///         matching the Solana 16-byte slug seed.
    struct EndpointConfig {
        bool paused;
        uint64 flatPremium;
        uint16 percentBps;
        uint32 slaLatencyMs;
        uint64 imputedCost;
        uint64 exposureCapPerHour;
        // Stats fields (total_calls / total_breaches / ...) omitted in the
        // scaffold; added in WP-EVM-02.
        FeeRecipient[8] feeRecipients;
        uint8 feeRecipientCount;
    }

    event EndpointRegistered(bytes16 indexed slug, address indexed pool);
    event EndpointConfigUpdated(bytes16 indexed slug);
    event EndpointPaused(bytes16 indexed slug, bool paused);
    event ProtocolPaused(bool paused);
    event FeeRecipientsUpdated(bytes16 indexed slug);

    function registerEndpoint(bytes16 slug, EndpointConfig calldata cfg) external;

    function updateEndpointConfig(bytes16 slug, EndpointConfig calldata cfg) external;

    function pauseEndpoint(bytes16 slug, bool paused) external;

    function pauseProtocol(bool paused) external;

    function updateFeeRecipients(
        bytes16 slug,
        FeeRecipient[8] calldata recipients,
        uint8 count
    ) external;
}
