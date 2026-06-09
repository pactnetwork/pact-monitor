// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Solidity custom errors mirroring Solana `PactError` (error.rs
///         6000-6032 — 30 named variants; 6003/6004/6009 are reserved gaps,
///         not errors). Numeric codes are NOT preserved; names and trigger
///         conditions are (design spec §3 binding rule: "every PactError
///         variant maps to a named Solidity custom error triggered by the
///         same condition"). Ordering follows error.rs.
///
///         NOTE: `FeeBpsSumOver10k` (error.rs 6018) is a DISTINCT error from
///         `FeeBpsExceedsCap` (6017): fee.rs:83-87 returns FeeBpsSumOver10k
///         when `sum_bps > ABSOLUTE_FEE_BPS_CAP` and FeeBpsExceedsCap when
///         `sum_bps > max_total_fee_bps`. The implementation plan's 29-error
///         list and design spec §3's enumerated list both OMIT 6018 — that is
///         a documentation defect; error.rs is the named authority and §3's
///         binding rule requires all 30. Recorded for WP-EVM-06 parity matrix.
///
///         Variants that lose meaning on EVM (InvalidAffiliateAta,
///         FeeRecipientInvalidUsdcMint) are kept declared for the parity
///         matrix but become unreachable (design spec §4 #7).
error InsufficientBalance();
error EndpointPaused();
error ExposureCapExceeded();
error UnauthorizedSettler();
error UnauthorizedAuthority();
error DuplicateCallId();
error EndpointNotFound();
error PoolDepleted();
error InvalidTimestamp();
error BatchTooLarge();
error PremiumTooSmall();
error InvalidSlug();
error ArithmeticOverflow();
error FeeRecipientArrayTooLong();
error FeeBpsExceedsCap();
error FeeBpsSumOver10k();
error FeeRecipientDuplicateDestination();
error FeeRecipientInvalidUsdcMint();
error MultipleTreasuryRecipients();
error RecipientCoverageMismatch();
error ProtocolConfigNotInitialized();
error TreasuryNotInitialized();
error EndpointAlreadyRegistered();
error InvalidFeeRecipientKind();
error InvalidProtocolConfig();
error InvalidTreasury();
error MissingTreasuryEntry();
error TreasuryBpsZero();
error InvalidAffiliateAta();
error ProtocolPaused();
