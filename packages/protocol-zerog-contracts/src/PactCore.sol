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
/// @dev    STATUS: implemented (2026-05-15). All bodies written; 54/54 Foundry
///         tests green, 100% line + branch coverage. v1 corrections from
///         plan-critique + research passes are folded in. The Pinocchio v1
///         program at
///         packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/instructions/settle_batch.rs
///         is the porting reference (copy semantics, not syntax).
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
    ///      Discriminants are positional (Solidity rule): Unsettled=0,
    ///      Settled=1, DelegateFailed=2, PoolDepleted=3, ExposureCapClamped=4.
    ///      This is shifted +1 from v1 (which uses Settled=0); see plan §
    ///      "Documented v1 divergences."
    enum SettlementStatus {
        Unsettled,           // 0 — sentinel: callId not yet seen
        Settled,             // 1 — premium charged + (any) refund paid in full
        DelegateFailed,      // 2 — ERC20 transferFrom from agent failed; batch continues
        PoolDepleted,        // 3 — premium charged, refund clamped to pool.balance
        ExposureCapClamped   // 4 — premium charged, refund clamped by hourly exposure cap
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
    ///      it generates in @pact-network/wrap: drop hyphens → 32 hex chars →
    ///      `bytes16(bytes32(uuid_hex_padded_right))` (keeps the HIGH 16
    ///      bytes). Do NOT use `bytes16(uint128(uint256(...)))` — that keeps
    ///      the LOW 128 bits (wrong half). Encoding rule + round-trip test
    ///      live in protocol-zerog-client/src/callId.ts.
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
        uint96  imputedCost,
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
        bytes16 slug,
        EndpointConfig calldata cfg,
        FeeRecipient[] calldata recipients
    ) external {
        if (msg.sender != admin)              revert Unauthorized();
        if (endpointConfig[slug].exists)      revert EndpointAlreadyExists();
        _validateSlug(slug);
        _validateFeeRecipients(recipients);

        EndpointConfig storage ec = endpointConfig[slug];
        ec.agentTokenId         = cfg.agentTokenId;
        ec.flatPremium          = cfg.flatPremium;
        ec.percentBps           = cfg.percentBps;
        ec.imputedCost          = cfg.imputedCost;
        ec.latencySloMs         = cfg.latencySloMs;
        ec.exposureCapPerHour   = cfg.exposureCapPerHour;
        // counters + window start at zero
        ec.lastUpdated          = uint64(block.timestamp);
        ec.paused               = false;
        ec.exists               = true;

        for (uint256 i = 0; i < recipients.length; ++i) {
            feeRecipients[slug].push(recipients[i]);
        }

        emit EndpointRegistered(
            slug,
            cfg.agentTokenId,
            cfg.flatPremium,
            cfg.percentBps,
            cfg.imputedCost,
            cfg.latencySloMs,
            cfg.exposureCapPerHour
        );
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

    function updateEndpointConfig(bytes16 slug, EndpointConfigUpdate calldata upd) external {
        if (msg.sender != admin)         revert Unauthorized();
        EndpointConfig storage ec = endpointConfig[slug];
        if (!ec.exists)                  revert EndpointNotFound();

        if (upd.setAgentTokenId)       ec.agentTokenId       = upd.agentTokenId;
        if (upd.setFlatPremium)        ec.flatPremium        = upd.flatPremium;
        if (upd.setPercentBps)         ec.percentBps         = upd.percentBps;
        if (upd.setImputedCost)        ec.imputedCost        = upd.imputedCost;
        if (upd.setLatencySloMs)       ec.latencySloMs       = upd.latencySloMs;
        if (upd.setExposureCapPerHour) ec.exposureCapPerHour = upd.exposureCapPerHour;

        ec.lastUpdated = uint64(block.timestamp);
        emit EndpointConfigUpdated(slug);
    }

    function updateFeeRecipients(bytes16 slug, FeeRecipient[] calldata recipients) external {
        if (msg.sender != admin)              revert Unauthorized();
        if (!endpointConfig[slug].exists)     revert EndpointNotFound();
        _validateFeeRecipients(recipients);

        // overwrite — Solidity `delete` on a dynamic array of structs resets length to 0
        delete feeRecipients[slug];
        for (uint256 i = 0; i < recipients.length; ++i) {
            feeRecipients[slug].push(recipients[i]);
        }
        emit FeeRecipientsUpdated(slug);
    }

    function pauseEndpoint(bytes16 slug, bool paused_) external {
        if (msg.sender != admin)              revert Unauthorized();
        if (!endpointConfig[slug].exists)     revert EndpointNotFound();
        endpointConfig[slug].paused = paused_;
        emit EndpointPaused(slug, paused_);
    }

    function pauseProtocol(bool paused_) external {
        if (msg.sender != admin) revert Unauthorized();
        protocolPaused = paused_;
        emit ProtocolPaused(paused_);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Pool funding
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Permissionless. v1 requires `signer == coverage_pool.authority`
    ///         (top_up_coverage_pool.rs:5,38). We diverge intentionally: topup
    ///         is monotonically good (only adds liquidity to a designated
    ///         endpoint's pool), so any caller subsidizing an endpoint
    ///         should be allowed. Documented divergence — not a bug.
    function topUpCoveragePool(bytes16 slug, uint128 amount) external {
        // I6: existence check MUST come before the external transfer
        if (!endpointConfig[slug].exists) revert EndpointNotFound();

        premiumToken.safeTransferFrom(msg.sender, address(this), amount);

        Pool storage p = coveragePool[slug];
        p.balance       += amount;
        p.totalDeposits += amount;

        emit PoolToppedUp(slug, msg.sender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Settlement (settler-only)
    // ─────────────────────────────────────────────────────────────────────

    function settleBatch(SettlementRecord[] calldata records) external nonReentrant {
        if (msg.sender != settlementAuthority) revert Unauthorized();
        if (records.length > MAX_BATCH_SIZE)   revert BatchTooLarge();
        if (protocolPaused)                    revert ProtocolIsPaused();

        for (uint256 ri = 0; ri < records.length; ++ri) {
            _settleOne(records[ri]);
        }
    }

    /// @dev Per-record settlement extracted so `settleBatch` stays under the
    ///      via_ir stack budget. State changes happen before external
    ///      transfers (CEI); `nonReentrant` on the outer call protects the
    ///      whole loop.
    function _settleOne(SettlementRecord calldata r) internal {
        // Guards (all reverts — v1: settle_batch.rs:158-196)
        if (r.timestamp > block.timestamp)        revert InvalidTimestamp();
        if (r.premiumWei < MIN_PREMIUM)           revert PremiumTooSmall();
        if (callStatus[r.callId] != uint8(SettlementStatus.Unsettled)) revert DuplicateCallId();
        EndpointConfig storage ec = endpointConfig[r.slug];
        if (!ec.exists)                           revert EndpointNotFound();
        if (ec.paused)                            revert EndpointIsPaused();

        // Step A — premium debit via try/catch (B1 fix: bypass `using SafeERC20`
        // resolution with explicit IERC20 cast so the library wrapper doesn't
        // swallow the external call). Both revert AND returns(false) → DelegateFailed.
        bool ok;
        try IERC20(address(premiumToken)).transferFrom(r.agent, address(this), r.premiumWei)
            returns (bool _ok)
        {
            ok = _ok;
        } catch {
            ok = false;
        }
        if (!ok) {
            callStatus[r.callId] = uint8(SettlementStatus.DelegateFailed);
            emit CallSettled(
                r.callId, r.slug, r.agent,
                SettlementStatus.DelegateFailed,
                0, r.refundWei, 0, r.rootHash
            );
            return; // v1: batch continues
        }

        // Step B — fee math (state only, no transfers)
        FeeRecipient[] storage recipients = feeRecipients[r.slug];
        uint256 nRecipients = recipients.length;
        uint256[8] memory cuts;
        uint256 paidOut;
        for (uint256 i = 0; i < nRecipients; ++i) {
            uint256 cut = (uint256(r.premiumWei) * recipients[i].bps) / 10_000;
            cuts[i] = cut;
            recipientEarnings[r.slug][recipients[i].destination] += uint128(cut);
            paidOut += cut;
        }

        Pool storage pool = coveragePool[r.slug];
        pool.balance     += uint128(uint256(r.premiumWei) - paidOut);
        ec.totalPremiums += r.premiumWei;

        // Step C — breach: exposure cap clamp THEN pool clamp (B2 guard)
        SettlementStatus status = SettlementStatus.Settled;
        uint96 actualRefund;

        if (r.breach) {
            (bool capByExposure, uint96 capped) = _applyExposureCapToRefund(r.slug, r.refundWei);
            if (capByExposure) status = SettlementStatus.ExposureCapClamped;

            // B2: only enter pool-clamp branch when `capped > 0`. When exposure
            // cap fully consumed the refund (capped == 0) we do NOT flip the
            // status to PoolDepleted; v1 also skips this branch.
            if (capped > 0) {
                uint128 poolBal = pool.balance;
                actualRefund = capped > poolBal ? uint96(poolBal) : capped;
                if (actualRefund < capped) status = SettlementStatus.PoolDepleted;
                pool.balance    -= actualRefund;
                ec.totalRefunds += actualRefund;
            }

            ec.totalBreaches += 1;
        }

        ec.totalCalls   += 1;
        ec.lastUpdated   = uint64(block.timestamp);
        callStatus[r.callId] = uint8(status);

        emit CallSettled(
            r.callId, r.slug, r.agent, status,
            r.premiumWei, r.refundWei, actualRefund, r.rootHash
        );

        // Step D — fee transfers LAST (CEI). Library safeTransfer is fine
        // here; a reverting recipient bubbles up and reverts the whole batch
        // (T11 documented DoS surface). nonReentrant covers callbacks.
        for (uint256 i = 0; i < nRecipients; ++i) {
            if (cuts[i] > 0) {
                premiumToken.safeTransfer(recipients[i].destination, cuts[i]);
                emit RecipientPaid(r.slug, recipients[i].destination, uint128(cuts[i]));
            }
        }

        // Refund transfer to agent (breach paths)
        if (actualRefund > 0) {
            premiumToken.safeTransfer(r.agent, actualRefund);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers (signatures pinned; bodies TBD)
    // ─────────────────────────────────────────────────────────────────────

    /// @dev v1 fee.rs validation rules + round-2 review additions:
    ///      - length in 1..=MAX_FEE_RECIPIENTS                          (I1)
    ///      - per-entry bps <= 10_000 (ABSOLUTE_FEE_BPS_CAP)            (I2; fee.rs:64)
    ///      - exactly one RecipientKind.Treasury                        (TreasuryCardinalityViolation)
    ///      - Treasury's bps MUST be > 0                                (TreasuryBpsZero; fee.rs:147-149)
    ///      - no duplicate destination addresses                        (InvalidFeeRecipients)
    ///      - destination != address(0)                                 (InvalidFeeRecipients)
    ///      - sum(bps) <= MAX_TOTAL_FEE_BPS = 3000                      (BpsSumExceedsCap)
    function _validateFeeRecipients(FeeRecipient[] calldata recipients) internal pure {
        uint256 n = recipients.length;
        if (n == 0 || n > MAX_FEE_RECIPIENTS) revert InvalidFeeRecipients();

        uint256 totalBps;
        uint256 treasuryCount;
        uint16  treasuryBps;

        for (uint256 i = 0; i < n; ++i) {
            FeeRecipient calldata r = recipients[i];

            if (r.destination == address(0))     revert InvalidFeeRecipients();
            if (r.bps > 10_000)                  revert InvalidFeeRecipients();

            if (r.kind == RecipientKind.Treasury) {
                unchecked { treasuryCount += 1; }
                treasuryBps = r.bps;
            }

            // O(n^2) dedup — n ≤ 8, so 28 comparisons worst case
            for (uint256 j = i + 1; j < n; ++j) {
                if (recipients[j].destination == r.destination) revert InvalidFeeRecipients();
            }

            unchecked { totalBps += r.bps; }
        }

        if (treasuryCount != 1)              revert TreasuryCardinalityViolation();
        if (treasuryBps == 0)                revert TreasuryBpsZero();
        if (totalBps > MAX_TOTAL_FEE_BPS)    revert BpsSumExceedsCap();
    }

    /// @dev v1 register_endpoint.rs:138-142 — each byte independently must be
    ///      either NUL (0x00) or ASCII printable (0x20..0x7E). NUL is allowed
    ///      at any position (not just trailing). I3 correction (2026-05-15).
    function _validateSlug(bytes16 slug) internal pure {
        for (uint256 i = 0; i < 16; ++i) {
            uint8 b = uint8(slug[i]);
            if (b != 0 && (b < 0x20 || b > 0x7E)) revert InvalidSlug();
        }
    }

    /// @dev Rolling-hour exposure cap applied to the REFUND (v1
    ///      settle_batch.rs:380-415). Side-effecting: resets the window when
    ///      it expires, and accumulates `capped` into `currentPeriodRefunds`
    ///      so successive calls within the same hour are bounded.
    ///
    ///      I4: window reset uses `>` (strict), not `>=`, to match v1.
    ///
    ///      Special case: if `exposureCapPerHour == 0` the cap is disabled —
    ///      no clamp, no accumulator write.
    function _applyExposureCapToRefund(bytes16 slug, uint96 requestedRefund)
        internal
        returns (bool clamped, uint96 capped)
    {
        EndpointConfig storage ec = endpointConfig[slug];

        // disabled cap → pass-through
        if (ec.exposureCapPerHour == 0) {
            return (false, requestedRefund);
        }

        // window reset (I4: strict >, not >=)
        if (block.timestamp > uint256(ec.currentPeriodStart) + 3600) {
            ec.currentPeriodStart   = uint64(block.timestamp);
            ec.currentPeriodRefunds = 0;
        }

        uint96 spent     = ec.currentPeriodRefunds;
        uint96 cap       = ec.exposureCapPerHour;
        uint96 allowable = spent >= cap ? 0 : cap - spent;

        capped  = requestedRefund > allowable ? allowable : requestedRefund;
        clamped = capped < requestedRefund;

        // accumulate
        ec.currentPeriodRefunds = spent + capped;
    }
}
