// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPactSettler} from "./interfaces/IPactSettler.sol";
import {IPactPool} from "./interfaces/IPactPool.sol";
import {IPactRegistry} from "./interfaces/IPactRegistry.sol";
import {ArcConfig} from "./ArcConfig.sol";
import "./errors/PactErrors.sol";

/// @title PactSettler
/// @notice One-per-chain settlement executor (design PR #201 §3.3). Holds the
///         settler role; for each call in a batch it pulls the premium from
///         the agent via `transferFrom`, credits the pool, fans out fees to
///         the registry's fee recipients, and pays the refund on SLA breach.
///         Kept separate from `PactPool` per the §3.3 recommendation (settler
///         holds the role; pool holds the money).
/// @dev WP-EVM-04 — AccessControl SETTLER_ROLE per GATE-A ruling on E2.
///      ctor: 3-arg (drop `address settler_`); DEFAULT_ADMIN_ROLE ->
///      registry.authority() (exact PactPool pattern). Deployed PactSettler
///      must hold SETTLER_ROLE on BOTH PactPool AND PactRegistry (E1xE2
///      two-layer grant wired in test setUp + deployment).
///      settleBatch logic ports in plans 03/04.
contract PactSettler is IPactSettler, AccessControl {
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    /// @notice USDC token (6-decimal ERC-20 interface). Premium-in and refund
    ///         settle in this asset; on Arc it is also the gas token.
    address public immutable usdc;

    /// @notice Registry that owns endpoint config + fee-recipient policy.
    IPactRegistry public immutable registry;

    /// @notice Pool that custodies endpoint liquidity.
    IPactPool public immutable pool;

    /// @notice Dedup sentinel — mirrors the Solana CallRecord PDA existence
    ///         check (settle_batch.rs:194-196). Set BEFORE the premium-in
    ///         try/catch so DelegateFailed events also consume the callId and
    ///         are not retryable (GATE-A E4, settle_batch.rs:243-262).
    mapping(bytes16 => bool) private _settledCallIds;

    /// @dev settle_batch.rs:396-399 — 3-arg ctor, DEFAULT_ADMIN_ROLE ->
    ///      registry.authority() (mirrors PactPool.sol:35).
    constructor(address usdc_, address registry_, address pool_) {
        usdc = usdc_;
        registry = IPactRegistry(registry_);
        pool = IPactPool(pool_);
        // Protocol authority administers roles (grants SETTLER_ROLE to
        // authorised settler signers post-deploy). registry.authority() is
        // set once in the PactRegistry constructor — effectively immutable.
        _grantRole(DEFAULT_ADMIN_ROLE, IPactRegistry(registry_).authority());
    }

    /// @inheritdoc IPactSettler
    /// @dev SETTLER_ROLE-gated (SET-01). Per-event guards (SET-03) in
    ///      settle_batch.rs:158-215 exact order. Dedup + premium-in (SET-02/04)
    ///      and economic half (SET-05/06/07/08) port in plans 03 Task 2 + 04.
    function settleBatch(SettlementEvent[] calldata events)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        for (uint256 i = 0; i < events.length; i++) {
            SettlementEvent calldata ev = events[i];

            // Step 2: per-event hard-revert guards — settle_batch.rs:158-166.
            // These abort the entire batch transaction (Err return in Rust),
            // not per-event continues.
            if (ev.timestamp > uint64(block.timestamp)) revert InvalidTimestamp();
            if (ev.premium < ArcConfig.MIN_PREMIUM) revert PremiumTooSmall();
            if (ev.feeRecipientCountHint > ArcConfig.MAX_FEE_RECIPIENTS)
                revert FeeRecipientArrayTooLong();

            // Step 3: endpoint snapshot — settle_batch.rs:200-221.
            // Endpoint-paused check (settle_batch.rs:209-211) is WP-05; skip.
            IPactRegistry.EndpointConfig memory ep =
                IPactRegistry(address(registry)).getEndpoint(ev.endpointSlug);
            if (ep.feeRecipientCount != ev.feeRecipientCountHint)
                revert RecipientCoverageMismatch();

            // Step 4: dedup check — settle_batch.rs:194-196.
            // Hard revert (aborts the whole batch), same as the Rust Err return.
            if (_settledCallIds[ev.callId]) revert DuplicateCallId();

            // Step 4 (cont): allocate dedup sentinel BEFORE premium-in —
            // settle_batch.rs:243-262 allocates the CallRecord PDA before the
            // delegate pre-flight so a replay of the same callId hits
            // DuplicateCallId even when the original event ended DelegateFailed
            // (GATE-A E4 ruling, MUST-VERIFY RESOLVED FROM SOURCE).
            _settledCallIds[ev.callId] = true;

            // Step 5: premium-in — settle_batch.rs:295-355.
            // Raw IERC20.transferFrom (NOT SafeERC20) inside try/catch so both
            // a false return and a revert are caught as DelegateFailed without
            // aborting the batch (RESEARCH §Q3 / pitfall 1).
            // Funds flow: agent -> address(pool) (pool is the USDC custodian).
            SettlementStatus status = SettlementStatus.Settled;
            bool premiumInOk;
            try IERC20(usdc).transferFrom(ev.agent, address(pool), ev.premium)
                returns (bool ok) { premiumInOk = ok; }
            catch { premiumInOk = false; }

            if (!premiumInOk) {
                // settle_batch.rs:332-355: DelegateFailed — write record,
                // continue. No funds move, no pool credit, no fee fan-out,
                // no refund, no endpoint-stats hook call.
                // GATE-A E3: emit ONLY IPactSettler.CallSettled (typed enum);
                // no second PactEvents emission; exactly one per call.
                status = SettlementStatus.DelegateFailed;
                emit CallSettled(
                    ev.callId,
                    ev.endpointSlug,
                    ev.agent,
                    ev.premium,
                    ev.refund,
                    0,           // actualRefund = 0 — no funds moved
                    status,
                    ev.breach,
                    ev.latencyMs,
                    ev.timestamp
                );
                continue;
            }

            // Steps 6-10 (pool credit + endpoint stats + fee fan-out + refund
            // + final CallSettled emit) port in plan 04-04.
            //
            // PROVISIONAL SEAM (plan 04-03 → plan 04-04):
            // premium-in succeeded — funds have moved agent→pool. The economic
            // half (creditPremium / recordCallAndCapAccrual / fee fan-out /
            // debitForRefund / recordRefundPaid) is not yet implemented.
            // Emit a provisional CallSettled(Settled, actualRefund=0) so the
            // first settle in test_DuplicateCallIdRejected does not revert.
            // Plan 04-04 MUST replace this provisional emit with the full
            // economic emit (still exactly one IPactSettler.CallSettled per
            // call per GATE-A E3 ruling).
            emit CallSettled(
                ev.callId,
                ev.endpointSlug,
                ev.agent,
                ev.premium,
                ev.refund,
                0,           // PROVISIONAL: actualRefund=0; plan 04-04 fills real value
                status,      // Settled
                ev.breach,
                ev.latencyMs,
                ev.timestamp
            );
        }
    }
}
