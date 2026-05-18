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
///      settleBatch economic loop (SET-05/06/07/08) ported in plan 04-04.
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
    ///      settle_batch.rs:158-215 exact order. Dedup + premium-in (SET-02/04,
    ///      plan 04-03) and economic half (SET-05/06/07/08, plan 04-04).
    function settleBatch(SettlementEvent[] calldata events)
        external
        override
        onlyRole(SETTLER_ROLE)
    {
        // settle_batch.rs:99-115 — protocol-paused fast-revert (SET-11).
        // PRE-loop, FIRST body statement (D-LOCK-PROTO-PAUSE). For the
        // operationally-real authorized settler this is bit-identical to Solana
        // ProtocolPaused; the unauthorized+paused corner is the P3
        // OPTIMIZED-DIVERGENCE (05-GATE-A-DECISIONS.md P3).
        if (registry.protocolPaused()) revert ProtocolPaused();
        // settle_batch.rs:132-135 — BatchTooLarge edge (SET-12). Strictly
        // greater: 50 OK, 51 rejects. AFTER the pause gate, BEFORE the loop
        // (D-LOCK-BATCH).
        if (events.length > ArcConfig.MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i = 0; i < events.length; i++) {
            SettlementEvent calldata ev = events[i];

            // Step 2: per-event hard-revert guards — settle_batch.rs:158-166.
            // These abort the entire batch transaction (Err return in Rust),
            // not per-event continues.
            if (ev.timestamp > uint64(block.timestamp)) revert InvalidTimestamp();
            if (ev.premium < ArcConfig.MIN_PREMIUM) revert PremiumTooSmall();
            if (ev.feeRecipientCountHint > ArcConfig.MAX_FEE_RECIPIENTS)
                revert FeeRecipientArrayTooLong();

            // Step 3: dedup check — settle_batch.rs:194-196. The Solana dedup
            // check ('!call_record.is_data_empty()' at :194) fires BEFORE the
            // endpoint snapshot's RecipientCoverageMismatch (:213
            // 'ep_count != fee_count_hint'). An event that is SIMULTANEOUSLY a
            // replayed callId AND feeRecipientCountHint != stored count MUST
            // revert DuplicateCallId — same input -> same error as Solana
            // (precedence parity; not a §4-ledger divergence). Hard revert
            // (aborts the whole batch), same as the Rust Err return.
            if (_settledCallIds[ev.callId]) revert DuplicateCallId();

            // Step 4: endpoint snapshot — settle_batch.rs:200-221.
            IPactRegistry.EndpointConfig memory ep =
                IPactRegistry(address(registry)).getEndpoint(ev.endpointSlug);
            // settle_batch.rs:209 — EndpointPaused (SET-11). D-LOCK-PREC slot:
            // AFTER the DuplicateCallId dedup READ (:84) and getEndpoint, BEFORE
            // RecipientCoverageMismatch. Pure additive insert — no WP-04 reorder.
            if (ep.paused) revert EndpointPaused();
            if (ep.feeRecipientCount != ev.feeRecipientCountHint)
                revert RecipientCoverageMismatch();

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
                emit CallSettled(
                    ev.callId,
                    ev.endpointSlug,
                    ev.agent,
                    ev.premium,
                    ev.refund,
                    0,           // actualRefund = 0 — no funds moved
                    SettlementStatus.DelegateFailed,
                    ev.breach,
                    ev.latencyMs,
                    ev.timestamp
                );
                continue;
            }

            // Steps 6-10: economic loop — pool credit, ep point 1, fee
            // fan-out, refund, ep point 2, final emit. Extracted to
            // _settleSuccess to avoid stack-too-deep (many locals in one frame).
            _settleSuccess(ev, ep);
        }
    }

    /// @dev Steps 6-10 of the per-event economic loop (settle_batch.rs:357-522).
    ///      Called ONLY on premium-in success. Extracted from settleBatch to
    ///      avoid Solidity stack-too-deep.
    ///
    ///      Mutation ORDER mirrors settle_batch.rs EXACTLY:
    ///      (6) pool.creditPremium [cp credit, :357-369]
    ///      (7) seed intendedRefundAfterCap [local, :380]
    ///      (7c) recordCallAndCapAccrual [ep point 1, :385-414, BEFORE fan-out]
    ///      (8) fee fan-out [pool.payout per recipient + pool.debitForFees, :418-453]
    ///      (9) refund transfer [pool.payout(agent) + pool.debitForRefund, :455-502]
    ///      (9c) recordRefundPaid [ep point 2, :493-499, AFTER transfer]
    ///      (10) emit CallSettled [one per call, GATE-A E3]
    function _settleSuccess(
        SettlementEvent calldata ev,
        IPactRegistry.EndpointConfig memory ep
    ) private {
        // Step 6 — Pool gross credit (settle_batch.rs:357-369).
        pool.creditPremium(ev.endpointSlug, ev.premium);

        // Step 7 + 7c — Seed the intended-refund value (settle_batch.rs:380)
        // then invoke ep mutation point 1 (settle_batch.rs:385-414). ev.refund
        // is the intendedRefundAfterCap seed (inlined to free one stack slot
        // that would otherwise cause stack-too-deep with the status local added
        // in WP-05). Semantics are identical: intendedRefundAfterCap == ev.refund
        // and the call site is UNCHANGED (P1 pin, 05-GATE-A-DECISIONS.md).
        // Returns payableRefund: == ev.refund in WP-04; cap-clamped in WP-05.
        uint64 payableRefund = IPactRegistry(address(registry))
            .recordCallAndCapAccrual(
                ev.endpointSlug,
                ev.premium,
                ev.breach,
                ev.refund        // intendedRefundAfterCap == ev.refund (settle_batch.rs:380)
            );

        // P1 (05-GATE-A-DECISIONS.md) -- infer ExposureCapClamped from the
        // seam-pinned return-value reduction. payableRefund < ev.refund
        // <=> intendedRefundAfterCap (ev.refund) > cap_remaining
        // <=> Solana intended > cap_remaining (settle_batch.rs:404-407).
        // Set BEFORE the pool-balance check so a later PoolDepleted overwrites
        // it (D-LOCK-CLAMP-ORDER; mirrors Solana :407-then-:468).
        SettlementStatus status = SettlementStatus.Settled;
        if (payableRefund < ev.refund) {
            status = SettlementStatus.ExposureCapClamped;
        }

        // Step 8 — Fee fan-out (settle_batch.rs:418-453).
        // fee = floor(uint256(premium) * bps / 10_000) cast to uint64.
        // Skip if zero. Accumulate totalFeePaid with overflow check.
        // Iterate ep.feeRecipientCount (NOT the hint — pitfall 6).
        uint64 totalFeePaid = 0;
        for (uint8 j = 0; j < ep.feeRecipientCount; j++) {
            uint64 feeAmount = uint64(
                uint256(ev.premium) * ep.feeRecipients[j].bps / 10_000
            );
            if (feeAmount == 0) continue;
            pool.payout(ep.feeRecipients[j].destination, feeAmount);
            totalFeePaid = _ckAdd(totalFeePaid, feeAmount);
        }
        if (totalFeePaid > 0) {
            pool.debitForFees(ev.endpointSlug, totalFeePaid);
        }

        // Step 9 — Refund on breach (settle_batch.rs:455-502).
        // WP-04 = sufficient-liquidity branch only (the else).
        // The settle_batch.rs:462-469 PoolDepleted DECISION is WP-05; leave
        // the EMPTY if as the additive seam — do NOT set status here.
        uint64 actualRefund = 0;
        if (payableRefund > 0) {
            IPactPool.PoolState memory ps = pool.balanceOf(ev.endpointSlug);
            if (ps.currentBalance < payableRefund) {
                // settle_batch.rs:462-469 PoolDepleted DECISION — WP-05.
                // Clean additive seam: WP-05 sets status=PoolDepleted &
                // actualRefund=0 HERE. WP-04 leaves this `if` EMPTY so the
                // refund transfer in the `else` is what WP-05 turns into the
                // pool-sufficient else without rewriting WP-04.
            } else {
                pool.payout(ev.agent, payableRefund);
                pool.debitForRefund(ev.endpointSlug, payableRefund);
                actualRefund = payableRefund;
            }
        }

        // Step 9c — ep mutation point 2: AFTER the refund transfer
        // (settle_batch.rs:493-499). totalRefunds += ACTUAL paid amount.
        // Called ONLY when actualRefund > 0 (mirrors Solana only reaching
        // :493-499 inside the paid else branch — GATE-A E1 SPLIT hook 2).
        if (actualRefund > 0) {
            IPactRegistry(address(registry)).recordRefundPaid(
                ev.endpointSlug,
                actualRefund
            );
        }

        // Step 10 — Emit exactly ONE IPactSettler.CallSettled per call
        // (plan-03 provisional seam replaced). GATE-A E3: typed enum, no
        // second PactEvents emission. Total = one per call either way
        // (DelegateFailed path in settleBatch + this Settled path = SET-08).
        emit CallSettled(
            ev.callId,
            ev.endpointSlug,
            ev.agent,
            ev.premium,
            ev.refund,
            actualRefund,
            status, // P1: ExposureCapClamped|PoolDepleted|Settled; DelegateFailed path already continued
            ev.breach,
            ev.latencyMs,
            ev.timestamp
        );
    }

    /// @dev Checked add mirroring PactPool._ckAdd (Solana checked_add ->
    ///      ArithmeticOverflow). Used for totalFeePaid accumulation.
    function _ckAdd(uint64 a, uint64 b) private pure returns (uint64 c) {
        unchecked {
            c = a + b;
        }
        if (c < a) revert ArithmeticOverflow();
    }
}
