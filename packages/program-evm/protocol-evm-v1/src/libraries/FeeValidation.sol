// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPactRegistry} from "../interfaces/IPactRegistry.sol";
import {ProtocolInvariants} from "../ProtocolInvariants.sol";
import "../errors/PactErrors.sol";

/// @notice Port of Solana fee.rs. Validation order and error mapping are
///         PARITY INVARIANTS — reproduced line-for-line against
///         `parse_and_validate` (fee.rs:44-90), `substitute_treasury_destination`
///         (fee.rs:96-106) and `validate_post_substitution` (fee.rs:128-161),
///         in that call sequence (register_endpoint / update_fee_recipients).
///         `validate_affiliate_atas` (fee.rs:175-217) — SPL token-account
///         introspection — has NO EVM equivalent and is intentionally dropped
///         per design spec §4 #7; an affiliate is a plain address. The `kind`
///         enum {Treasury=0, AffiliateAta=1, AffiliatePda=2} is preserved on
///         the wire/events for indexer parity. `InvalidAffiliateAta` /
///         `FeeRecipientInvalidUsdcMint` become unreachable (§4 #7).
///
///         FeeBpsSumOver10k vs FeeBpsExceedsCap split is exact per fee.rs:
///         per-entry bps > cap and sum > maxTotal → FeeBpsExceedsCap;
///         sum > ABSOLUTE_FEE_BPS_CAP → FeeBpsSumOver10k.
library FeeValidation {
    /// @return sumBps total basis points across the validated recipients.
    function validate(
        IPactRegistry.FeeRecipient[8] memory recipients,
        uint8 count,
        uint16 maxTotalFeeBps,
        address treasuryVault
    ) internal pure returns (uint32 sumBps) {
        // fee.rs:49-51 — count guard FIRST, before any indexing.
        if (count > ProtocolInvariants.MAX_FEE_RECIPIENTS) revert FeeRecipientArrayTooLong();
        // fee.rs:52-54 — wire byte-length guard: N/A on EVM (typed array).

        // --- parse_and_validate loop (fee.rs:61-82) ---
        bool treasurySeen;
        sumBps = 0;
        for (uint256 i = 0; i < count; i++) {
            IPactRegistry.FeeRecipient memory e = recipients[i];
            // decode_entry (fee.rs:24-27) — invalid kind discriminant
            // (FeeRecipientKind::from_u8 None for v > 2).
            if (e.kind > 2) revert InvalidFeeRecipientKind();
            // fee.rs:64-66 — per-entry bps cap.
            if (e.bps > ProtocolInvariants.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsExceedsCap();
            // fee.rs:67-72 — at most one Treasury (in-loop).
            if (e.kind == 0) {
                if (treasurySeen) revert MultipleTreasuryRecipients();
                treasurySeen = true;
            }
            // fee.rs:73-77 — PRE-substitution duplicate destination, vs all
            // already-decoded raw destinations (substitution runs later).
            for (uint256 j = 0; j < i; j++) {
                if (recipients[j].destination == e.destination) {
                    revert FeeRecipientDuplicateDestination();
                }
            }
            // fee.rs:78-80 — checked sum. uint16 bps with count <= 8 cannot
            // overflow uint32; Solana's ArithmeticOverflow is equally
            // unreachable on valid count, so parity holds with no dead check.
            sumBps += uint32(e.bps);
        }

        // fee.rs:83-85 — sum over absolute cap (10_000) → FeeBpsSumOver10k.
        if (sumBps > ProtocolInvariants.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsSumOver10k();
        // fee.rs:86-88 — sum over operator cap → FeeBpsExceedsCap.
        if (sumBps > maxTotalFeeBps) revert FeeBpsExceedsCap();

        // --- substitute_treasury_destination (fee.rs:96-106) ---
        for (uint256 i = 0; i < count; i++) {
            if (recipients[i].kind == 0) {
                recipients[i].destination = treasuryVault;
            }
        }

        // --- validate_post_substitution (fee.rs:128-161) ---
        uint256 treasuryCount;
        uint16 treasuryBps;
        for (uint256 i = 0; i < count; i++) {
            if (recipients[i].kind == 0) {
                treasuryCount += 1;
                treasuryBps = recipients[i].bps;
            }
        }
        if (treasuryCount == 0) revert MissingTreasuryEntry(); // fee.rs:140-142
        // fee.rs:143-146 — defensive; parse loop already bounds Treasury to 1.
        if (treasuryCount > 1) revert MultipleTreasuryRecipients();
        if (treasuryBps == 0) revert TreasuryBpsZero(); // fee.rs:147-149
        // fee.rs:153-159 — POST-substitution duplicate destination.
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = 0; j < i; j++) {
                if (recipients[i].destination == recipients[j].destination) {
                    revert FeeRecipientDuplicateDestination();
                }
            }
        }

        // EVM-adapted affiliate validation (design spec §4 #7, lines 94/135).
        // Solana's validate_affiliate_atas (fee.rs:175-217, called AFTER
        // validate_post_substitution in register_endpoint) does SPL token-
        // account introspection with no EVM equivalent. The residual EVM-
        // meaningful invariant from §4 #7 is "non-zero": an affiliate
        // (kind != Treasury, i.e. 1/2 — kind already bounded to 0..2 above)
        // must not be the zero address, else it registers fine then breaks
        // settlement. InvalidAffiliateAta is the affiliate-validity error in
        // error.rs; trigger narrowed (ATA introspection -> zero-address guard)
        // => OPTIMIZED-DIVERGENCE, not N/A — recorded for the WP-06 parity
        // matrix / §4 #7 wording fix.
        for (uint256 i = 0; i < count; i++) {
            if (recipients[i].kind != 0 && recipients[i].destination == address(0)) {
                revert InvalidAffiliateAta();
            }
        }
    }

    /// @notice Port of initialize_protocol_config.rs:84-156 — the bespoke
    ///         default-template validator §4 #6 collapses into the
    ///         PactRegistry constructor. DELIBERATELY DISTINCT from `validate`
    ///         (the source's own codex-2026-05-05 comment: no Treasury PDA
    ///         exists at init → NO substitution and NO post-substitution dup
    ///         pass; `count == 0` is intentionally allowed so operators can
    ///         require per-endpoint recipients). Kept separate on purpose —
    ///         two validators mirror two distinct Solana code paths; do not
    ///         unify. Stores RAW entries (caller persists `recipients` as-is).
    function validateDefaultTemplate(
        IPactRegistry.FeeRecipient[8] memory recipients,
        uint8 count,
        uint16 maxTotalFeeBps
    ) internal pure {
        // rs:80-82 — count guard FIRST.
        if (count > ProtocolInvariants.MAX_FEE_RECIPIENTS) revert FeeRecipientArrayTooLong();
        // rs:84-86 — config check unique to init_pc (not in fee.rs).
        if (maxTotalFeeBps > ProtocolInvariants.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsExceedsCap();

        // rs:92-124 — entry loop. NO substitution.
        bool treasurySeen;
        uint32 sumBps;
        for (uint256 i = 0; i < count; i++) {
            IPactRegistry.FeeRecipient memory e = recipients[i];
            if (e.kind > 2) revert InvalidFeeRecipientKind();
            if (e.bps > ProtocolInvariants.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsExceedsCap();
            if (e.kind == 0) {
                if (treasurySeen) revert MultipleTreasuryRecipients();
                treasurySeen = true;
            }
            for (uint256 j = 0; j < i; j++) {
                if (recipients[j].destination == e.destination) {
                    revert FeeRecipientDuplicateDestination();
                }
            }
            sumBps += uint32(e.bps);
        }

        // rs:125-130 — sum checks.
        if (sumBps > ProtocolInvariants.ABSOLUTE_FEE_BPS_CAP) revert FeeBpsSumOver10k();
        if (sumBps > maxTotalFeeBps) revert FeeBpsExceedsCap();

        // rs:138-156 — Treasury invariants ONLY when count > 0. count == 0 is
        // intentionally allowed (empty defaults).
        if (count > 0) {
            uint256 treasuryCount;
            uint16 treasuryBps;
            for (uint256 i = 0; i < count; i++) {
                if (recipients[i].kind == 0) {
                    treasuryCount += 1;
                    treasuryBps = recipients[i].bps;
                }
            }
            if (treasuryCount == 0) revert MissingTreasuryEntry();
            if (treasuryCount > 1) revert MultipleTreasuryRecipients();
            if (treasuryBps == 0) revert TreasuryBpsZero();
        }
    }
}
