// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPactRegistry} from "./interfaces/IPactRegistry.sol";
import {PactEvents} from "./PactEvents.sol";
import {ArcConfig} from "./ArcConfig.sol";
import {FeeValidation} from "./libraries/FeeValidation.sol";
import "./errors/PactErrors.sol";

/// @title PactRegistry
/// @notice One-per-chain endpoint registry, fee-recipient policy and protocol
///         kill switch. EVM analogue of the Solana `EndpointConfig` +
///         `ProtocolConfig` PDAs. The 3 Solana `initialize_*` instructions
///         collapse into the constructor (design spec §4 #6); per-endpoint
///         PDAs collapse into slug-keyed mappings (§4 #2).
/// @dev Behavioral port of register_endpoint.rs / update_endpoint_config.rs /
///      update_fee_recipients.rs / pause_endpoint.rs / pause_protocol.rs /
///      initialize_protocol_config.rs. Validation order mirrors the Solana
///      handlers exactly (parity invariants, design spec §3).
///
///      N/A-on-EVM (Solana-platform mechanics, §4 #2/#6/#7):
///      - mint == USDC_DEVNET/MAINNET (FeeRecipientInvalidUsdcMint): no mint
///        account on EVM; `usdc` is the stored immutable.
///      - PDA derivation / InvalidSeeds / AccountAlreadyInitialized /
///        signer / rent / system_program: no PDAs/rent on EVM.
///      - SettlementAuthority / Treasury PDA + SPL vault init: §4 #5/#6.
contract PactRegistry is IPactRegistry, PactEvents, AccessControl {
    /// @dev GATE-A E1 (OPTION (a)) — same literal as PactPool.sol:22.
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    address public override authority;
    address public usdc;
    address public override treasuryVault;
    uint16 public override maxTotalFeeBps;
    bool public override protocolPaused;

    /// @dev Stored RAW (no Treasury substitution) — mirrors
    ///      initialize_protocol_config.rs which cannot substitute (no Treasury
    ///      PDA at init). Substitution happens per-endpoint in registerEndpoint.
    IPactRegistry.FeeRecipient[8] private _defaultFeeRecipients;
    uint8 private _defaultCount;

    mapping(bytes16 => EndpointConfig) private _endpoints;
    mapping(bytes16 => bool) private _registered;

    modifier onlyAuthority() {
        if (msg.sender != authority) revert UnauthorizedAuthority();
        _;
    }

    /// @notice Collapses initialize_protocol_config + initialize_treasury
    ///         (§4 #6). Default template validated via the bespoke
    ///         `validateDefaultTemplate` (initialize_protocol_config.rs:84-156
    ///         semantics: no substitution, count == 0 allowed).
    constructor(
        address authority_,
        address usdc_,
        address treasuryVault_,
        uint16 maxTotalFeeBps_,
        IPactRegistry.FeeRecipient[8] memory defaultRecipients_,
        uint8 defaultCount_
    ) {
        FeeValidation.validateDefaultTemplate(defaultRecipients_, defaultCount_, maxTotalFeeBps_);
        authority = authority_;
        // GATE-A E1 condition (1): mirrors PactPool.sol:35 — protocol authority
        // administers SETTLER_ROLE grants (grants PactSettler SETTLER_ROLE post-deploy).
        _grantRole(DEFAULT_ADMIN_ROLE, authority_);
        usdc = usdc_;
        treasuryVault = treasuryVault_;
        maxTotalFeeBps = maxTotalFeeBps_;
        for (uint256 i = 0; i < 8; i++) {
            _defaultFeeRecipients[i] = defaultRecipients_[i];
        }
        _defaultCount = defaultCount_;
        protocolPaused = false;
    }

    /// @dev register_endpoint.rs slug guard: a byte that is non-zero and
    ///      outside printable ASCII [0x20, 0x7E] → InvalidSlug.
    function _validateSlug(bytes16 slug) private pure {
        for (uint256 i = 0; i < 16; i++) {
            uint8 b = uint8(slug[i]);
            if (b != 0 && (b < 0x20 || b > 0x7E)) revert InvalidSlug();
        }
    }

    /// @inheritdoc IPactRegistry
    /// @dev Order mirrors register_endpoint.rs exactly: authority →
    ///      slug → build entries (explicit / default-copy) → fee validation
    ///      (parse+substitute+post-sub+§4#7 via FeeValidation.validate) →
    ///      EndpointAlreadyRegistered → write. Fee validation precedes the
    ///      already-registered check (register_endpoint.rs steps 9-13).
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
    ) external override onlyAuthority {
        _validateSlug(slug);

        IPactRegistry.FeeRecipient[8] memory entries;
        uint8 count;
        if (feeRecipientsPresent) {
            for (uint256 i = 0; i < 8; i++) entries[i] = feeRecipients[i];
            count = feeRecipientCount;
        } else {
            // register_endpoint.rs: pc_default_count > MAX → FeeRecipientArrayTooLong
            if (_defaultCount > ArcConfig.MAX_FEE_RECIPIENTS) revert FeeRecipientArrayTooLong();
            for (uint256 i = 0; i < 8; i++) entries[i] = _defaultFeeRecipients[i];
            count = _defaultCount;
        }

        // register_endpoint.rs steps 9-12: (parse_and_validate if present) +
        // substitute_treasury_destination + validate_post_substitution +
        // validate_affiliate_atas(→ §4#7 guard). FeeValidation.validate
        // bundles all four and substitutes Treasury dest in-place; idempotent
        // on construction-validated defaults (immutable maxTotalFeeBps).
        FeeValidation.validate(entries, count, maxTotalFeeBps, treasuryVault);

        // register_endpoint.rs step 13: !endpoint.is_data_empty() →
        // EndpointAlreadyRegistered (AFTER fee validation).
        if (_registered[slug]) revert EndpointAlreadyRegistered();

        EndpointConfig storage c = _endpoints[slug];
        c.paused = false;
        c.flatPremium = flatPremium;
        c.percentBps = percentBps;
        c.slaLatencyMs = slaLatencyMs;
        c.imputedCost = imputedCost;
        c.exposureCapPerHour = exposureCapPerHour;
        c.totalCalls = 0;
        c.totalBreaches = 0;
        c.totalPremiums = 0;
        c.totalRefunds = 0;
        c.currentPeriodStart = uint64(block.timestamp);
        c.currentPeriodRefunds = 0;
        c.lastUpdated = uint64(block.timestamp);
        c.feeRecipientCount = count;
        for (uint256 i = 0; i < 8; i++) c.feeRecipients[i] = entries[i];

        _registered[slug] = true;
        emit EndpointRegistered(slug);
    }

    /// @inheritdoc IPactRegistry
    /// @dev update_endpoint_config.rs. Solana applies per-field presence
    ///      flags; the EVM port takes a full field set (EVM-idiomatic,
    ///      typed calldata) — callers pass current values for unchanged
    ///      fields. Sets last_updated; no fee re-validation (parity).
    function updateEndpointConfig(
        bytes16 slug,
        uint64 flatPremium,
        uint16 percentBps,
        uint32 slaLatencyMs,
        uint64 imputedCost,
        uint64 exposureCapPerHour
    ) external override onlyAuthority {
        if (!_registered[slug]) revert EndpointNotFound();
        EndpointConfig storage c = _endpoints[slug];
        c.flatPremium = flatPremium;
        c.percentBps = percentBps;
        c.slaLatencyMs = slaLatencyMs;
        c.imputedCost = imputedCost;
        c.exposureCapPerHour = exposureCapPerHour;
        c.lastUpdated = uint64(block.timestamp);
        emit EndpointConfigUpdated(slug);
    }

    /// @inheritdoc IPactRegistry
    /// @dev update_fee_recipients.rs: parse_and_validate + substitute +
    ///      validate_post_substitution + validate_affiliate_atas → bundled
    ///      FeeValidation.validate. Replaces the array atomically.
    function updateFeeRecipients(bytes16 slug, FeeRecipient[8] calldata recipients, uint8 count)
        external
        override
        onlyAuthority
    {
        if (!_registered[slug]) revert EndpointNotFound();
        IPactRegistry.FeeRecipient[8] memory entries;
        for (uint256 i = 0; i < 8; i++) entries[i] = recipients[i];
        FeeValidation.validate(entries, count, maxTotalFeeBps, treasuryVault);

        EndpointConfig storage c = _endpoints[slug];
        c.feeRecipientCount = count;
        for (uint256 i = 0; i < 8; i++) c.feeRecipients[i] = entries[i];
        c.lastUpdated = uint64(block.timestamp);
        emit FeeRecipientsUpdated(slug);
    }

    /// @inheritdoc IPactRegistry
    /// @dev pause_endpoint.rs: state.paused = data[0]. Authority-only.
    function pauseEndpoint(bytes16 slug, bool paused) external override onlyAuthority {
        if (!_registered[slug]) revert EndpointNotFound();
        _endpoints[slug].paused = paused;
        emit EndpointPaused(slug, paused);
    }

    /// @inheritdoc IPactRegistry
    /// @dev pause_protocol.rs: state.paused = data[0]. Authority-only.
    function pauseProtocol(bool paused) external override onlyAuthority {
        protocolPaused = paused;
        emit ProtocolPaused(paused);
    }

    /// @inheritdoc IPactRegistry
    function getEndpoint(bytes16 slug) external view override returns (EndpointConfig memory) {
        return _endpoints[slug];
    }

    /// @inheritdoc IPactRegistry
    function isRegistered(bytes16 slug) external view override returns (bool) {
        return _registered[slug];
    }

    // -----------------------------------------------------------------------
    // WP-EVM-04 GATE-A E1 (OPTION (a)) — SETTLER_ROLE-gated endpoint-stats
    // hooks mirroring settle_batch.rs's TWO distinct ep.* mutation points.
    // PURE ADDITION: no existing function signature or behavior altered.
    // D1 scope refinement (GATE-A §E1): WP-03 D1 barred PactPool reaching into
    // the registry; it does NOT bar WP-04 adding its own gated stat-writer
    // where spec §6 places EndpointConfig state. Sanctioned additive extension.
    // -----------------------------------------------------------------------

    /// @dev Checked add mirroring PactPool.sol:79-84 (Solana checked_add ->
    ///      ArithmeticOverflow named error, not Panic 0x11).
    function _ckAdd(uint64 a, uint64 b) private pure returns (uint64 c) {
        unchecked {
            c = a + b;
        }
        if (c < a) revert ArithmeticOverflow();
    }

    /// @inheritdoc IPactRegistry
    /// @dev settle_batch.rs:385-414 — ep mutation point 1, called BEFORE fee
    ///      fan-out. Mutation ORDER matches source EXACTLY:
    ///      totalCalls -> totalPremiums -> totalBreaches -> period-reset ->
    ///      (WP-05 cap-clamp seam) -> currentPeriodRefunds(payableRefund).
    function recordCallAndCapAccrual(
        bytes16 slug,
        uint64 premium,
        bool breach,
        uint64 intendedRefund
    ) external override onlyRole(SETTLER_ROLE) returns (uint64 payableRefund) {
        if (!_registered[slug]) revert EndpointNotFound();
        EndpointConfig storage ep = _endpoints[slug];

        // settle_batch.rs:385
        ep.totalCalls = _ckAdd(ep.totalCalls, 1);
        // settle_batch.rs:386-389
        ep.totalPremiums = _ckAdd(ep.totalPremiums, premium);
        // settle_batch.rs:390-395
        if (breach) ep.totalBreaches = _ckAdd(ep.totalBreaches, 1);
        // settle_batch.rs:396-399  PERIOD RESET (WP-04, D-SPLIT refinement)
        if (uint64(block.timestamp) > ep.currentPeriodStart + 3600) {
            ep.currentPeriodStart = uint64(block.timestamp);
            ep.currentPeriodRefunds = 0;
        }
        payableRefund = intendedRefund;
        // settle_batch.rs:400-408 -- exposure-cap clamp (SET-10). Solana
        // saturating_sub on uint64 -> ternary guard (no underflow possible).
        // The clamped payableRefund is returned to the UNCHANGED _settleSuccess
        // call site (P1, 05-GATE-A-DECISIONS.md). The accrual below uses the
        // post-cap amount (D-LOCK-CLAMP-ORDER; NOT rolled back on PoolDepleted).
        if (payableRefund > 0) {
            uint64 capRemaining = ep.exposureCapPerHour > ep.currentPeriodRefunds
                ? ep.exposureCapPerHour - ep.currentPeriodRefunds
                : 0;
            if (payableRefund > capRemaining) {
                payableRefund = capRemaining;
            }
        }
        // settle_batch.rs:409-414 -- uses the post-cap (clamped) amount
        if (payableRefund > 0) {
            ep.currentPeriodRefunds = _ckAdd(ep.currentPeriodRefunds, payableRefund);
        }
        return payableRefund;
    }

    /// @inheritdoc IPactRegistry
    /// @dev settle_batch.rs:493-499 — ep mutation point 2, called AFTER the
    ///      refund transfer. Uses ACTUAL paid amount (distinct from
    ///      intendedRefund — differs when WP-05 cap-clamp fires).
    function recordRefundPaid(
        bytes16 slug,
        uint64 actualRefund
    ) external override onlyRole(SETTLER_ROLE) {
        if (!_registered[slug]) revert EndpointNotFound();
        EndpointConfig storage ep = _endpoints[slug];
        // settle_batch.rs:493-499  (WP-04) — ACTUAL paid amount
        ep.totalRefunds = _ckAdd(ep.totalRefunds, actualRefund);
    }
}
