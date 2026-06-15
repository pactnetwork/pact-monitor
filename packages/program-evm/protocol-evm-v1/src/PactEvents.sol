// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Protocol events. Solana emits none; these are the EVM-idiomatic
///         on-chain truth source for the indexer (design spec §4 #3).
interface PactEvents {
    event EndpointRegistered(bytes16 indexed slug);
    event EndpointConfigUpdated(bytes16 indexed slug);
    event EndpointPaused(bytes16 indexed slug, bool paused);
    event ProtocolPaused(bool paused);
    event FeeRecipientsUpdated(bytes16 indexed slug);
    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint64 amount);
    event CallSettled(
        bytes16 indexed callId,
        bytes16 indexed slug,
        address indexed agent,
        uint64 premium,
        uint64 refund,
        uint64 actualRefund,
        uint8 status,
        bool breach,
        uint32 latencyMs,
        uint64 timestamp
    );
}
