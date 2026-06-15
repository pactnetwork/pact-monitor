// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPactRegistry
/// @notice Endpoint registry, fee-recipient policy, protocol config and the
///         protocol kill switch. EVM analogue of the Solana `EndpointConfig`
///         + `ProtocolConfig` PDAs. The 3 Solana `initialize_*` instructions
///         collapse into the constructor + setters (design spec §4 #6); the
///         per-endpoint PDAs collapse into slug-keyed mappings (§4 #2).
interface IPactRegistry {
    /// @notice One fee-split destination. `kind`: 0 = Treasury,
    ///         1 = AffiliateAta, 2 = AffiliatePda. `bps` is basis points.
    ///         Layout is a parity invariant — consumed by FeeValidation.
    struct FeeRecipient {
        uint8 kind;
        address destination;
        uint16 bps;
    }

    /// @notice Per-endpoint config. Mirrors Solana `state.rs` `EndpointConfig`
    ///         field set; `bump`/padding/`slug`/`coverage_pool` are
    ///         platform-specific and dropped (§4 #2/#4). `*_lamports` →
    ///         plain `uint64` (USDC is the Arc 6-dec ERC-20, §4 #8).
    struct EndpointConfig {
        bool paused;
        uint64 flatPremium;
        uint16 percentBps;
        uint32 slaLatencyMs;
        uint64 imputedCost;
        uint64 exposureCapPerHour;
        uint64 totalCalls;
        uint64 totalBreaches;
        uint64 totalPremiums;
        uint64 totalRefunds;
        uint64 currentPeriodStart;
        uint64 currentPeriodRefunds;
        uint64 lastUpdated;
        uint8 feeRecipientCount;
        FeeRecipient[8] feeRecipients;
    }

    function registerEndpoint(
        bytes16 slug,
        uint64 flatPremium,
        uint16 percentBps,
        uint32 slaLatencyMs,
        uint64 imputedCost,
        uint64 exposureCapPerHour,
        bool feeRecipientsPresent,
        uint8 feeRecipientCount,
        FeeRecipient[8] calldata feeRecipients
    ) external;

    function updateEndpointConfig(
        bytes16 slug,
        uint64 flatPremium,
        uint16 percentBps,
        uint32 slaLatencyMs,
        uint64 imputedCost,
        uint64 exposureCapPerHour
    ) external;

    function updateFeeRecipients(bytes16 slug, FeeRecipient[8] calldata recipients, uint8 count) external;
    function pauseEndpoint(bytes16 slug, bool paused) external;
    function pauseProtocol(bool paused) external;

    function getEndpoint(bytes16 slug) external view returns (EndpointConfig memory);
    function isRegistered(bytes16 slug) external view returns (bool);
    function protocolPaused() external view returns (bool);
    function authority() external view returns (address);
    function treasuryVault() external view returns (address);
    function maxTotalFeeBps() external view returns (uint16);

    // -----------------------------------------------------------------------
    // WP-EVM-04 GATE-A E1 (OPTION (a)) — SETTLER_ROLE-gated endpoint-stats
    // hooks mirroring settle_batch.rs's TWO distinct ep.* mutation points.
    // -----------------------------------------------------------------------

    /// @notice settle_batch.rs:385-414 — ep mutation point 1, called BEFORE
    ///         fee fan-out. Accumulates totalCalls/totalPremiums/totalBreaches,
    ///         performs the WP-04 period reset, then accrues currentPeriodRefunds.
    ///         Returns payableRefund (== intendedRefund in WP-04; WP-05 returns
    ///         the cap-clamped amount without changing this signature).
    function recordCallAndCapAccrual(
        bytes16 slug,
        uint64 premium,
        bool breach,
        uint64 intendedRefund
    ) external returns (uint64 payableRefund);

    /// @notice settle_batch.rs:493-499 — ep mutation point 2, called AFTER the
    ///         refund transfer. Accumulates totalRefunds with the ACTUAL paid
    ///         amount (distinct from intendedRefund — differs when WP-05 clamps).
    function recordRefundPaid(bytes16 slug, uint64 actualRefund) external;
}
