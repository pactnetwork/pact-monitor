// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPactSettler
/// @notice Executes settlement batches: pulls premium from the agent
///         (`transferFrom`), credits the pool, fans out fees, pays the
///         refund on SLA breach. Holds the settler role.
/// @dev Shape mirrors the design sketch in PR #201 §3.3. EVM analogue of the
///      Solana `settle_batch` instruction. WP-EVM-01 scaffold: one
///      `CallSettled` event per call in the batch — the indexer reads these
///      directly (WP-EVM-11).
interface IPactSettler {
    /// @notice One settled call. `callId` / `endpointSlug` are 16-byte ids.
    struct SettlementEvent {
        bytes16 callId;
        address agent;
        bytes16 endpointSlug;
        uint64 premium;
        uint64 refund;
        uint32 latencyMs;
        bool breach;
        uint8 feeRecipientCountHint;
        uint64 timestamp;
    }

    /// @notice Per-call settlement outcome. Mirrors the Solana
    ///         `SettlementStatus` enum.
    enum SettlementStatus {
        Settled,
        DelegateFailed,
        PoolDepleted,
        ExposureCapClamped
    }

    event CallSettled(
        bytes16 indexed callId,
        bytes16 indexed slug,
        address indexed agent,
        uint64 premium,
        uint64 refund,
        uint64 actualRefund,
        SettlementStatus status,
        bool breach,
        uint32 latencyMs,
        uint64 timestamp
    );

    function settleBatch(SettlementEvent[] calldata events) external;
}
