// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPactRegistry} from "./interfaces/IPactRegistry.sol";

/// @title PactRegistry
/// @notice One-per-chain endpoint registry, fee-recipient policy and protocol
///         kill switch (design PR #201 §3.1, §3.4 — single contract per role,
///         not a factory per endpoint). EVM analogue of the Solana
///         `EndpointConfig` + `ProtocolConfig` PDAs.
/// @dev WP-EVM-01 SCAFFOLD. Storage layout, events and signatures only; every
///      state-transition function reverts `NOT_IMPLEMENTED`. Real logic ports
///      in WP-EVM-02 from `register_endpoint.rs`,
///      `initialize_protocol_config.rs`, `update_endpoint_config.rs`,
///      `update_fee_recipients.rs`, `pause_endpoint.rs`, `pause_protocol.rs`.
contract PactRegistry is IPactRegistry {
    /// @notice Protocol owner / operator.
    /// @dev TODO(WP-EVM-02): replace with OpenZeppelin access control;
    ///      WP-EVM-07 rotates this to a Safe multisig.
    address public owner;

    /// @notice Global kill switch (design §3.1 `ProtocolPaused`).
    bool public protocolPaused;

    /// @notice slug => endpoint config. A single contract holds every
    ///         endpoint's config (design §3.4).
    mapping(bytes16 => EndpointConfig) internal _endpoints;

    /// @notice slug => registered, to distinguish "unset" from
    ///         "registered but paused".
    mapping(bytes16 => bool) internal _registered;

    constructor(address owner_) {
        owner = owner_;
    }

    /// @inheritdoc IPactRegistry
    function registerEndpoint(bytes16, EndpointConfig calldata) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactRegistry
    function updateEndpointConfig(bytes16, EndpointConfig calldata) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactRegistry
    function pauseEndpoint(bytes16, bool) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactRegistry
    function pauseProtocol(bool) external override {
        revert("NOT_IMPLEMENTED");
    }

    /// @inheritdoc IPactRegistry
    function updateFeeRecipients(
        bytes16,
        FeeRecipient[8] calldata,
        uint8
    ) external override {
        revert("NOT_IMPLEMENTED");
    }
}
