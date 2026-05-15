// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20}          from "@openzeppelin/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/utils/ReentrancyGuard.sol";

/// @title  Pact-0G insurance core
/// @notice EVM port of the v1 Pinocchio program at
///         packages/program/programs-pinocchio/pact-network-v1-pinocchio.
///         Per-endpoint coverage pools, per-call premium debit, on-breach
///         clamped refund, fee splits to Treasury + Affiliates.
///
/// @dev  STATUS: skeleton. State, errors, events, and function signatures are
///       final per ~/.claude/plans/ok-great-lets-brainstorm-steady-stearns.md.
///       Bodies are stubs and revert with `NotImplemented`. Week-1 contract
///       work fills the bodies per the v1 semantics — see
///       packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs
///       for the reference implementation.
contract PactCore is ReentrancyGuard {
    // ─────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Hard cap on records per settleBatch call. Matches v1.
    uint16 public constant MAX_BATCH_SIZE = 50;

    /// @notice Hard cap on sum of fee-recipient BPS per endpoint. 3000 = 30%.
    ///         Matches v1's `DEFAULT_MAX_TOTAL_FEE_BPS`.
    uint16 public constant MAX_TOTAL_FEE_BPS = 3000;

    /// @notice Max fee recipients per endpoint (Treasury + up to 8 affiliates).
    uint8 public constant MAX_FEE_RECIPIENTS = 8;

    // ─────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────

    enum RecipientKind { Treasury, Affiliate }

    enum SettlementStatus {
        Unsettled,                // sentinel: callId not seen on-chain
        Settled,                  // premium debited successfully
        Refunded,                 // breach refunded in full
        PoolDepleted,             // breach refunded partially; pool empty
        DelegateFailed,           // ERC20 transferFrom from agent failed
        ExposureCapClamped        // hourly exposure cap clamped the premium
    }

    struct EndpointConfig {
        uint256 agentTokenId;     // ERC-7857 INFT id (0 if no INFT linked)
        uint96  premiumPerCall;   // premiumToken base units
        uint96  refundOnBreach;
        uint16  latencySloMs;
        uint96  exposureCapPerHour;
        bool    paused;
        bool    exists;
    }

    struct Pool {
        uint128 balance;
        uint128 totalDeposits;
        uint128 totalPremiums;
        uint128 totalRefunds;
        uint64  windowStartTs;    // rolling-hour exposure-cap window start
        uint128 windowSpent;
    }

    struct FeeRecipient {
        RecipientKind kind;
        address       destination;
        uint16        bps;        // sum across array <= MAX_TOTAL_FEE_BPS
    }

    /// @dev v1's CallRecord input shape. callId is 16 bytes matching the Solana sentinel.
    struct SettlementRecord {
        bytes16 callId;
        bytes16 slug;
        address agent;
        bool    breach;
        uint96  premiumWei;
        uint96  refundWei;
        bytes32 rootHash;         // 0G Storage rootHash (single value — there's no separate CID)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────

    address public admin;
    address public settlementAuthority;
    bool    public protocolPaused;
    address public defaultTreasury;
    IERC20  public immutable premiumToken;

    mapping(bytes16 => EndpointConfig)                     public endpointConfig;
    mapping(bytes16 => Pool)                               public coveragePool;
    mapping(bytes16 => FeeRecipient[])                     public feeRecipients;
    mapping(bytes16 => uint8)                              public callStatus;     // dedup-as-status
    mapping(bytes16 => mapping(address => uint128))        public recipientEarnings;

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event EndpointRegistered(
        bytes16 indexed slug,
        uint256 indexed agentTokenId,
        uint96  premiumPerCall,
        uint96  refundOnBreach,
        uint16  latencySloMs,
        uint96  exposureCapPerHour
    );
    event EndpointConfigUpdated(bytes16 indexed slug);
    event FeeRecipientsUpdated(bytes16 indexed slug);
    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint128 amount);
    event CallSettled(
        bytes16 indexed callId,
        bytes16 indexed slug,
        address indexed agent,
        SettlementStatus status,
        uint96  premium,
        uint96  refund,
        bytes32 rootHash
    );
    event EndpointPaused(bytes16 indexed slug, bool paused);
    event ProtocolPaused(bool paused);

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ProtocolIsPaused();
    error EndpointNotFound();
    error EndpointIsPaused();
    error BatchTooLarge();
    error InvalidFeeRecipients();
    error BpsSumExceedsCap();
    error TreasuryCardinalityViolation();
    error NotImplemented();

    // ─────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────

    constructor(
        address _admin,
        address _settlementAuthority,
        address _defaultTreasury,
        IERC20  _premiumToken
    ) {
        admin                = _admin;
        settlementAuthority  = _settlementAuthority;
        defaultTreasury      = _defaultTreasury;
        premiumToken         = _premiumToken;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Admin operations
    // ─────────────────────────────────────────────────────────────────────

    function registerEndpoint(
        bytes16 /*slug*/,
        EndpointConfig calldata /*cfg*/,
        FeeRecipient[] calldata /*recipients*/
    ) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
        // 1. validate cfg.exists == false (no double-register)
        // 2. validate recipients per _validateFeeRecipients()
        // 3. store cfg with exists=true, paused=false
        // 4. store recipients
        // 5. emit EndpointRegistered
    }

    function updateEndpointConfig(bytes16 /*slug*/, EndpointConfig calldata /*cfg*/) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
        // v1 semantics: field-level updates, not whole-struct replace. Plan calls
        // this out explicitly. Implementer: take an EndpointConfigUpdate struct
        // with optional flags per field, or expose granular setters. The current
        // calldata shape is a placeholder.
    }

    function updateFeeRecipients(bytes16 /*slug*/, FeeRecipient[] calldata /*recipients*/) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
    }

    function pauseEndpoint(bytes16 /*slug*/, bool /*paused*/) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
    }

    function pauseProtocol(bool /*paused*/) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Permissionless funding
    // ─────────────────────────────────────────────────────────────────────

    function topUpCoveragePool(bytes16 /*slug*/, uint128 /*amount*/) external {
        revert NotImplemented();
        // 1. require endpointConfig[slug].exists
        // 2. premiumToken.transferFrom(msg.sender, address(this), amount)
        // 3. pool.balance += amount; pool.totalDeposits += amount
        // 4. emit PoolToppedUp
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement (settler-only)
    // ─────────────────────────────────────────────────────────────────────

    function settleBatch(SettlementRecord[] calldata records) external nonReentrant {
        if (msg.sender != settlementAuthority) revert Unauthorized();
        if (records.length > MAX_BATCH_SIZE)   revert BatchTooLarge();
        if (protocolPaused)                    revert ProtocolIsPaused();

        revert NotImplemented();
        // For each record:
        //   if callStatus[callId] != Unsettled                 continue   (silent dedup)
        //   if !endpointConfig[slug].exists                    continue
        //   if endpointConfig[slug].paused                     continue
        //
        //   if (r.breach):
        //     actualRefund   = min(r.refundWei, pool.balance)
        //     finalStatus    = (actualRefund < r.refundWei) ? PoolDepleted : Refunded
        //     // CEI: state first
        //     pool.balance      -= actualRefund
        //     pool.totalRefunds += actualRefund
        //     callStatus[r.callId] = uint8(finalStatus)
        //     // transfer last
        //     premiumToken.transfer(r.agent, actualRefund)
        //   else:
        //     (clamped, premium) = _applyExposureCap(r.slug, r.premiumWei)
        //     finalStatus = clamped ? ExposureCapClamped : Settled
        //     // CEI: pull from agent
        //     premiumToken.transferFrom(r.agent, address(this), premium)
        //     // CEI: state-only computations
        //     paidOut = 0
        //     cuts[8] memory
        //     for i, rec in feeRecipients[slug]:
        //       cuts[i] = premium * rec.bps / 10_000
        //       recipientEarnings[slug][rec.destination] += cuts[i]
        //       paidOut += cuts[i]
        //     pool.balance       += (premium - paidOut)
        //     pool.totalPremiums += premium
        //     callStatus[r.callId] = uint8(finalStatus)
        //     // CEI: transfers last
        //     for i, rec in feeRecipients[slug]:
        //       premiumToken.transfer(rec.destination, cuts[i])
        //
        //   emit CallSettled(r.callId, r.slug, r.agent, finalStatus, premium, actualRefund, r.rootHash)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers (signatures pinned; bodies TBD)
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Validates the fee-recipient array per v1's rules:
    ///      - length <= MAX_FEE_RECIPIENTS
    ///      - exactly one RecipientKind.Treasury (TreasuryCardinalityViolation otherwise)
    ///      - no duplicate destination addresses
    ///      - sum(bps) <= MAX_TOTAL_FEE_BPS (3000 = 30%)
    function _validateFeeRecipients(FeeRecipient[] calldata /*recipients*/) internal pure {
        revert NotImplemented();
    }

    /// @dev Returns (clamped, effectivePremium) for the rolling-hour exposure cap.
    ///      Resets pool.windowSpent when block.timestamp - pool.windowStartTs >= 3600.
    function _applyExposureCap(bytes16 /*slug*/, uint96 /*requestedPremium*/)
        internal
        returns (bool clamped, uint96 effectivePremium)
    {
        revert NotImplemented();
    }
}
