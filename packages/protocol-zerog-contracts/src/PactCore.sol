// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20}          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  Pact-0G insurance core
/// @notice EVM port of the v1 Pinocchio program at
///         packages/program/programs-pinocchio/pact-network-v1-pinocchio.
///         Per-endpoint coverage pools, per-call premium debit, on-breach
///         clamped refund, fee splits to Treasury + Affiliates.
///
/// @dev    STATUS: revised skeleton (2026-05-15) after plan-critique + research
///         agents reviewed the first draft and found v1 semantic divergences.
///         All v1 corrections from
///         ~/.claude/plans/ok-great-lets-brainstorm-steady-stearns.md
///         Implementation step 1 v2 are folded into this layout. Bodies are
///         stubs and revert with `NotImplemented`. Implementer fills bodies
///         per the v1 semantics — see
///         packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs
///         for the reference.
contract PactCore is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────
    // Constants — v1 parity (see constants.rs)
    // ─────────────────────────────────────────────────────────────────────

    uint16 public constant MAX_BATCH_SIZE      = 50;     // v1: MAX_BATCH_SIZE
    uint16 public constant MAX_TOTAL_FEE_BPS   = 3_000;  // v1: DEFAULT_MAX_TOTAL_FEE_BPS (30 %)
    uint8  public constant MAX_FEE_RECIPIENTS  = 8;      // v1: MAX_FEE_RECIPIENTS (total cap including Treasury)
    uint96 public constant MIN_PREMIUM         = 100;    // v1: MIN_PREMIUM_LAMPORTS — sub-units of premiumToken

    // ─────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────

    enum RecipientKind { Treasury, Affiliate }

    /// @dev v1 has 4 statuses (state.rs). Discriminant `0` is reserved as
    ///      the "Unsettled" sentinel for the `callStatus` dedup mapping —
    ///      it is NOT a real settlement state and must never be emitted.
    enum SettlementStatus {
        Unsettled          = 0,  // sentinel: callId not yet seen
        Settled            = 1,  // premium charged + (any) refund paid in full
        DelegateFailed     = 2,  // ERC20 transferFrom from agent failed — premium NOT charged; batch continues
        PoolDepleted       = 3,  // premium charged, refund clamped to pool.balance (may be 0)
        ExposureCapClamped = 4   // premium charged, refund clamped by hourly exposure cap
    }

    /// @dev Mirrors v1 EndpointConfig (state.rs). Holds full config + rolling
    ///      exposure-cap window + lifetime stats. Pool tracks only balance.
    struct EndpointConfig {
        // identity
        uint256 agentTokenId;             // ERC-7857 INFT id (0 if no INFT linked)
        // pricing
        uint96  flatPremium;              // v1: flat_premium_lamports
        uint16  percentBps;               // v1: percent_bps (premium = flat + cost * percentBps/10000)
        uint96  imputedCost;              // v1: imputed_cost_lamports (proxy attaches per-call)
        uint16  latencySloMs;             // v1: sla_latency_ms (note: u16 truncates from v1's u32 — OK; SLO ≤ 65535 ms)
        // exposure cap window — lives on EndpointConfig per v1 (NOT on Pool)
        uint96  exposureCapPerHour;       // v1: exposure_cap_per_hour_lamports
        uint64  currentPeriodStart;       // v1: current_period_start (unix seconds)
        uint96  currentPeriodRefunds;     // v1: current_period_refunds (paid in window)
        // lifetime stats
        uint64  totalCalls;               // v1: total_calls
        uint64  totalBreaches;            // v1: total_breaches
        uint96  totalPremiums;            // v1: total_premiums
        uint96  totalRefunds;             // v1: total_refunds
        uint64  lastUpdated;              // v1: last_updated
        // flags
        bool    paused;
        bool    exists;
    }

    /// @dev Pool is just liquidity. All operational state moved to EndpointConfig.
    struct Pool {
        uint128 balance;                  // current mUSDC residual
        uint128 totalDeposits;            // lifetime in via topUpCoveragePool
    }

    struct FeeRecipient {
        RecipientKind kind;
        address       destination;
        uint16        bps;                // Treasury must be > 0; Σ bps ≤ MAX_TOTAL_FEE_BPS
    }

    /// @dev Settler input record. callId is 16 bytes matching v1's sentinel.
    ///      The settler MUST encode `callId` as the 16-byte form of the UUID
    ///      it generates in @pact-network/wrap (drop hyphens → 32 hex chars →
    ///      `bytes16(uint128(uint256(...)))`). Encoding rule documented in
    ///      protocol-zerog-client/src/types.ts.
    struct SettlementRecord {
        bytes16 callId;
        bytes16 slug;
        address agent;
        bool    breach;
        uint96  premiumWei;
        uint96  refundWei;            // requested refund (= breach amount settler computed)
        uint64  timestamp;            // unix seconds; PactCore rejects timestamps > block.timestamp
        bytes32 rootHash;             // 0G Storage rootHash (single value — there's no separate CID)
    }

    // ─────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────

    address public admin;
    address public settlementAuthority;
    bool    public protocolPaused;
    address public defaultTreasury;
    IERC20  public immutable premiumToken;

    mapping(bytes16 => EndpointConfig)             public endpointConfig;
    mapping(bytes16 => Pool)                       public coveragePool;
    mapping(bytes16 => FeeRecipient[])             public feeRecipients;
    mapping(bytes16 => uint8)                      public callStatus;          // dedup-as-status, see SettlementStatus
    mapping(bytes16 => mapping(address => uint128)) public recipientEarnings;  // lifetime per (slug, recipient)

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event EndpointRegistered(
        bytes16 indexed slug,
        uint256 indexed agentTokenId,
        uint96  flatPremium,
        uint16  percentBps,
        uint96  refundOnBreach,
        uint16  latencySloMs,
        uint96  exposureCapPerHour
    );
    event EndpointConfigUpdated(bytes16 indexed slug);
    event FeeRecipientsUpdated(bytes16 indexed slug);
    event PoolToppedUp(bytes16 indexed slug, address indexed funder, uint128 amount);

    /// @dev Emits both the requested refund (`refund`) and what actually paid
    ///      out (`actualRefund`) so the indexer can show the gap when status
    ///      is `PoolDepleted` or `ExposureCapClamped`.
    event CallSettled(
        bytes16 indexed callId,
        bytes16 indexed slug,
        address indexed agent,
        SettlementStatus status,
        uint96  premium,
        uint96  refund,
        uint96  actualRefund,
        bytes32 rootHash
    );

    /// @dev Per-recipient payout event so the indexer derives earnings from
    ///      logs alone (no off-chain duplication needed). v1 lacks this event
    ///      but adds the indexer-derive step; we emit instead.
    event RecipientPaid(bytes16 indexed slug, address indexed recipient, uint128 amount);

    event EndpointPaused(bytes16 indexed slug, bool paused);
    event ProtocolPaused(bool paused);

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ProtocolIsPaused();
    error EndpointNotFound();
    error EndpointIsPaused();
    error EndpointAlreadyExists();
    error BatchTooLarge();
    error DuplicateCallId();                   // v1: settle_batch.rs:194-196 — REVERT, not skip
    error InvalidFeeRecipients();
    error BpsSumExceedsCap();
    error TreasuryCardinalityViolation();
    error TreasuryBpsZero();                   // v1: PactError::TreasuryBpsZero (fee.rs:147-149)
    error PremiumTooSmall();                   // v1: premium < MIN_PREMIUM_LAMPORTS
    error InvalidTimestamp();                  // v1: timestamp > now reject (settle_batch.rs:158-160)
    error InvalidSlug();                       // v1: register_endpoint.rs:138-142 ASCII validation
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
        // 1. require endpointConfig[slug].exists == false (else EndpointAlreadyExists)
        // 2. _validateSlug(slug) — bytes must be 0x20..0x7E (ASCII printable)
        // 3. _validateFeeRecipients(recipients)
        // 4. store cfg with exists=true, paused=false, lastUpdated=block.timestamp
        // 5. push recipients into feeRecipients[slug]
        // 6. emit EndpointRegistered
    }

    /// @dev v1 uses an explicit per-field `present:u8` flag struct for partial
    ///      updates (update_endpoint_config.rs). The EVM equivalent below uses
    ///      an `EndpointConfigUpdate` struct that explicitly names which
    ///      fields are present. Implementer: define this struct + helper that
    ///      iterates the present-flags and writes only the named fields.
    ///      DO NOT use zero-sentinel "no change" — it conflates "set to zero"
    ///      (a legitimate value, e.g. exposureCapPerHour = 0) with "leave alone".
    struct EndpointConfigUpdate {
        bool    setAgentTokenId;          uint256 agentTokenId;
        bool    setFlatPremium;           uint96  flatPremium;
        bool    setPercentBps;            uint16  percentBps;
        bool    setImputedCost;           uint96  imputedCost;
        bool    setLatencySloMs;          uint16  latencySloMs;
        bool    setExposureCapPerHour;    uint96  exposureCapPerHour;
    }

    function updateEndpointConfig(bytes16 /*slug*/, EndpointConfigUpdate calldata /*upd*/) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
    }

    function updateFeeRecipients(bytes16 /*slug*/, FeeRecipient[] calldata /*recipients*/) external {
        if (msg.sender != admin) revert Unauthorized();
        revert NotImplemented();
        // _validateFeeRecipients + clear feeRecipients[slug] + push new recipients + emit
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
    // Pool funding
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Permissionless. v1 requires `signer == coverage_pool.authority`
    ///         (top_up_coverage_pool.rs:5,38). We diverge intentionally: topup
    ///         is monotonically good (only adds liquidity to a designated
    ///         endpoint's pool), so any caller subsidizing an endpoint
    ///         should be allowed. Documented divergence — not a bug.
    function topUpCoveragePool(bytes16 /*slug*/, uint128 /*amount*/) external {
        revert NotImplemented();
        // 1. require endpointConfig[slug].exists
        // 2. premiumToken.safeTransferFrom(msg.sender, address(this), amount)
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
        // For each r in records:
        //   if r.timestamp > block.timestamp           revert InvalidTimestamp
        //   if r.premiumWei < MIN_PREMIUM              revert PremiumTooSmall
        //   if callStatus[r.callId] != Unsettled       revert DuplicateCallId   // v1 reverts, doesn't skip
        //   if !endpointConfig[r.slug].exists          revert EndpointNotFound
        //   if endpointConfig[r.slug].paused           revert EndpointIsPaused
        //
        //   --- v1-faithful clamp logic ---
        //   actualRefund = r.refundWei
        //   status       = Settled
        //
        //   // Step A: premium debit. DelegateFailed flow needs try/catch, which
        //   //  REQUIRES an external function call (SafeERC20 is a library —
        //   //  `using SafeERC20 for IERC20;` doesn't make it external). So we
        //   //  call `premiumToken.transferFrom` directly and treat both
        //   //  revert AND `returns(false)` as DelegateFailed. Non-standard
        //   //  ERC20s that revert without returning bool are still caught.
        //   bool ok = false
        //   try premiumToken.transferFrom(r.agent, address(this), r.premiumWei) returns (bool _ok) {
        //       ok = _ok
        //   } catch {
        //       ok = false
        //   }
        //   if (!ok):
        //       callStatus[r.callId] = uint8(DelegateFailed)
        //       emit CallSettled(r.callId, r.slug, r.agent, DelegateFailed, 0, r.refundWei, 0, r.rootHash)
        //       continue   // v1: batch continues; this record charges no premium
        //
        //   // Step B: state-only fee math
        //   uint256 paidOut = 0
        //   uint256[8] memory cuts
        //   for (i, rec) in feeRecipients[r.slug]:
        //       cuts[i] = r.premiumWei * rec.bps / 10_000
        //       recipientEarnings[r.slug][rec.destination] += cuts[i]
        //       paidOut += cuts[i]
        //   pool.balance       += (r.premiumWei - paidOut)
        //   ec.totalPremiums   += r.premiumWei
        //
        //   // Step C: if breach, apply exposure cap THEN pool clamp TO THE REFUND
        //   //         (v1: settle_batch.rs:380-415 — cap clamps refund, not premium)
        //   if (r.breach):
        //       (cappedByExposure, capped) = _applyExposureCapToRefund(r.slug, r.refundWei)
        //       if (cappedByExposure):
        //           status = ExposureCapClamped
        //       actualRefund = min(capped, pool.balance)
        //       if (actualRefund < capped):
        //           status = PoolDepleted    // overrides ExposureCapClamped if both fire
        //       pool.balance      -= actualRefund
        //       ec.totalRefunds   += actualRefund
        //       ec.totalBreaches  += 1
        //
        //   ec.totalCalls   += 1
        //   ec.lastUpdated   = block.timestamp
        //   callStatus[r.callId] = uint8(status)
        //
        //   emit CallSettled(r.callId, r.slug, r.agent, status, r.premiumWei,
        //                    r.refundWei, actualRefund, r.rootHash)
        //
        //   // Step D: fee transfers — at the END to keep state changes before
        //   //         external calls. Reentrancy guard covers callbacks; we
        //   //         intentionally let a malicious recipient revert this
        //   //         record (T11) — the batch's outer call reverts. v1's
        //   //         settle_batch has the same DoS surface; pull-pattern
        //   //         deferred to v2.
        //   for (i, rec) in feeRecipients[r.slug]:
        //       if (cuts[i] > 0):                  // v1: skip zero-fee transfers
        //           premiumToken.safeTransfer(rec.destination, cuts[i])     // library call OK here; reverts bubble
        //           emit RecipientPaid(r.slug, rec.destination, uint128(cuts[i]))
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers (signatures pinned; bodies TBD)
    // ─────────────────────────────────────────────────────────────────────

    /// @dev v1 fee.rs validation rules:
    ///      - length in 1..=MAX_FEE_RECIPIENTS
    ///      - exactly one RecipientKind.Treasury (else TreasuryCardinalityViolation)
    ///      - Treasury's bps MUST be > 0 (else TreasuryBpsZero)        // fee.rs:147-149
    ///      - no duplicate destination addresses (else InvalidFeeRecipients)
    ///      - sum(bps) <= MAX_TOTAL_FEE_BPS = 3000 (else BpsSumExceedsCap)
    function _validateFeeRecipients(FeeRecipient[] calldata /*recipients*/) internal pure {
        revert NotImplemented();
    }

    /// @dev v1 register_endpoint.rs:138-142 — slug bytes must each be in the
    ///      ASCII printable range 0x20..0x7E. Trailing NUL padding (0x00) is
    ///      allowed AFTER the meaningful prefix. Implementer: walk forward
    ///      until first NUL, verify each preceding byte is 0x20..=0x7E, then
    ///      verify all remaining bytes are NUL.
    function _validateSlug(bytes16 /*slug*/) internal pure {
        revert NotImplemented();
    }

    /// @dev Rolling-hour exposure cap applied to the REFUND (v1
    ///      settle_batch.rs:380-415). Returns `(clamped, allowableRefund)`:
    ///      - if block.timestamp - ec.currentPeriodStart >= 3600, reset window
    ///      - allowable = ec.exposureCapPerHour - ec.currentPeriodRefunds
    ///      - capped    = min(requestedRefund, allowable)
    ///      - clamped   = (capped < requestedRefund)
    ///      - on return, caller should add `capped` to ec.currentPeriodRefunds
    function _applyExposureCapToRefund(bytes16 /*slug*/, uint96 /*requestedRefund*/)
        internal
        returns (bool clamped, uint96 allowableRefund)
    {
        revert NotImplemented();
    }
}
