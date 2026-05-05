/// settle_batch — process up to MAX_BATCH_SIZE settlement events with the
/// new per-endpoint pool + SPL-Token-delegate-based agent custody +
/// fee fan-out flow (Step C/A + B + C).
///
/// Per-event flow:
///   1. Validate EndpointConfig for slug + paused + exposure cap.
///   2. Init CallRecord PDA (rejects duplicate call_id).
///   3. Premium-in: SPL Token Transfer agent_ata → pool_vault for full
///      premium, authority = SettlementAuthority PDA (program-signed via
///      invoke_signed). The delegate must be pre-approved off-chain.
///   4. Fee fan-out: for each i in 0..ep.fee_recipient_count, transfer
///      pool_vault → fee_recipient_ata for `premium * bps / 10_000`.
///      Authority = CoveragePool PDA.
///   5. Refund (on breach): pool_vault → agent_ata for refund amount,
///      authority = CoveragePool PDA.
///
/// Account layout — fixed prefix (4):
///   0. settler_signer
///   1. settlement_authority PDA (readonly; also acts as token delegate)
///   2. token_program
///   3. system_program
///
/// Per-event accounts (5 + N where N = endpoint.fee_recipient_count):
///   0. call_record PDA (writable, init)
///   1. coverage_pool PDA (writable, slug-derived)
///   2. coverage_pool USDC vault (writable)
///   3. endpoint_config PDA (writable)
///   4. agent USDC ATA (writable)
///   5..5+N. fee recipient ATAs (writable), in EndpointConfig order
///
/// Wire data:
///   0-1:  event_count u16 LE
///   per event (104 bytes):
///     0-15:   call_id [u8; 16]
///     16-47:  agent owner pubkey [u8; 32]
///     48-63:  endpoint_slug [u8; 16]
///     64-71:  premium_lamports u64
///     72-79:  refund_lamports u64
///     80-83:  latency_ms u32
///     84:     breach u8
///     85:     fee_recipient_count_hint u8 (must match endpoint state)
///     86-91:  _pad [u8; 6]
///     92-99:  timestamp i64
///     100-103: _pad2 [u8; 4]
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    constants::{MAX_BATCH_SIZE, MAX_FEE_RECIPIENTS, MIN_PREMIUM_LAMPORTS},
    error::PactError,
    pda::{
        derive_call_record, derive_coverage_pool, derive_endpoint_config,
        SEED_COVERAGE_POOL, SEED_CALL, SEED_SETTLEMENT_AUTHORITY,
    },
    state::{
        CallRecord, CoveragePool, EndpointConfig, FeeRecipient, SettlementAuthority,
        SettlementStatus,
    },
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{transfer_pda_signed, SPL_TOKEN_PROGRAM_ID},
};

const FIXED_ACCOUNTS: usize = 4;
const FIXED_PER_EVENT: usize = 5; // call_record, pool, pool_vault, endpoint, agent_ata
const BYTES_PER_EVENT: usize = 104;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < FIXED_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let settler_signer = &accounts[0];
    let settlement_auth = &accounts[1];
    let token_program = &accounts[2];
    let system_program = &accounts[3];

    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !settler_signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify settler_signer matches SettlementAuthority.signer and read bump.
    let sa_bump;
    {
        let sa_data = settlement_auth.try_borrow()?;
        if sa_data.len() < SettlementAuthority::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let sa: &SettlementAuthority =
            bytemuck::from_bytes(&sa_data[..SettlementAuthority::LEN]);
        if &sa.signer != settler_signer.address() {
            return Err(PactError::UnauthorizedSettler.into());
        }
        sa_bump = sa.bump;
    }

    let event_count = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    if event_count > MAX_BATCH_SIZE {
        return Err(PactError::BatchTooLarge.into());
    }
    if data.len() < 2 + event_count * BYTES_PER_EVENT {
        return Err(ProgramError::InvalidInstructionData);
    }

    let now = Clock::get()?.unix_timestamp;
    let rent = Rent::get()?;

    let mut acct_cursor = FIXED_ACCOUNTS;
    for i in 0..event_count {
        let ev_start = 2 + i * BYTES_PER_EVENT;
        let ev = &data[ev_start..ev_start + BYTES_PER_EVENT];

        let call_id: [u8; 16] = ev[0..16].try_into().unwrap();
        let agent_owner: [u8; 32] = ev[16..48].try_into().unwrap();
        let endpoint_slug: [u8; 16] = ev[48..64].try_into().unwrap();
        let premium_lamports = u64::from_le_bytes(ev[64..72].try_into().unwrap());
        let refund_lamports = u64::from_le_bytes(ev[72..80].try_into().unwrap());
        let latency_ms = u32::from_le_bytes(ev[80..84].try_into().unwrap());
        let breach = ev[84];
        let fee_count_hint = ev[85] as usize;
        let timestamp = i64::from_le_bytes(ev[92..100].try_into().unwrap());

        if timestamp > now {
            return Err(PactError::InvalidTimestamp.into());
        }
        if premium_lamports < MIN_PREMIUM_LAMPORTS {
            return Err(PactError::PremiumTooSmall.into());
        }
        if fee_count_hint > MAX_FEE_RECIPIENTS {
            return Err(PactError::FeeRecipientArrayTooLong.into());
        }

        let needed_for_event = FIXED_PER_EVENT + fee_count_hint;
        if accounts.len() < acct_cursor + needed_for_event {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let call_record_acct = &accounts[acct_cursor];
        let pool_acct = &accounts[acct_cursor + 1];
        let pool_vault_acct = &accounts[acct_cursor + 2];
        let endpoint_acct = &accounts[acct_cursor + 3];
        let agent_ata_acct = &accounts[acct_cursor + 4];
        let fee_atas_base = acct_cursor + FIXED_PER_EVENT;

        // Verify PDAs.
        let (expected_call_record, cr_bump) = derive_call_record(&call_id);
        if call_record_acct.address() != &expected_call_record {
            return Err(ProgramError::InvalidSeeds);
        }
        let (expected_pool, pool_bump) = derive_coverage_pool(&endpoint_slug);
        if pool_acct.address() != &expected_pool {
            return Err(ProgramError::InvalidSeeds);
        }
        let (expected_ep, _) = derive_endpoint_config(&endpoint_slug);
        if endpoint_acct.address() != &expected_ep {
            return Err(ProgramError::InvalidSeeds);
        }

        if !call_record_acct.is_data_empty() {
            return Err(PactError::DuplicateCallId.into());
        }

        // Read endpoint snapshot — fee_recipient_count must match hint, and
        // we capture the [u8; 32] destination + bps array for fan-out.
        let fee_recipients_snapshot: [FeeRecipient; MAX_FEE_RECIPIENTS];
        let ep_count;
        let cached_pool_pubkey;
        {
            let ep_data = endpoint_acct.try_borrow()?;
            if ep_data.len() < EndpointConfig::LEN {
                return Err(ProgramError::InvalidAccountData);
            }
            let ep: &EndpointConfig = bytemuck::from_bytes(&ep_data[..EndpointConfig::LEN]);
            if ep.paused != 0 {
                return Err(PactError::EndpointPaused.into());
            }
            ep_count = ep.fee_recipient_count as usize;
            if ep_count != fee_count_hint {
                return Err(PactError::RecipientCoverageMismatch.into());
            }
            fee_recipients_snapshot = ep.fee_recipients;
            cached_pool_pubkey = ep.coverage_pool;
        }
        if &cached_pool_pubkey != pool_acct.address() {
            return Err(PactError::RecipientCoverageMismatch.into());
        }

        // Read pool snapshot — verify vault binding.
        {
            let pool_data = pool_acct.try_borrow()?;
            if pool_data.len() < CoveragePool::LEN {
                return Err(ProgramError::InvalidAccountData);
            }
            let cp: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
            if &cp.usdc_vault != pool_vault_acct.address() {
                return Err(ProgramError::InvalidAccountData);
            }
        }

        // Verify each fee_recipient ATA matches the endpoint config order.
        for j in 0..ep_count {
            let acct = &accounts[fee_atas_base + j];
            if acct.address() != &fee_recipients_snapshot[j].destination {
                return Err(PactError::RecipientCoverageMismatch.into());
            }
        }

        // Allocate CallRecord PDA up front so a replay of the same call_id
        // hits `DuplicateCallId` even when the original event was settled
        // with a non-Settled status (DelegateFailed, PoolDepleted, etc).
        // The settler signer pays rent regardless of outcome — settle_batch
        // is operator-run, so this is acceptable.
        let cr_lamports = rent.try_minimum_balance(CallRecord::LEN)?;
        let cr_bump_seed = [cr_bump];
        let cr_signer_seeds: [Seed; 3] = [
            Seed::from(SEED_CALL),
            Seed::from(&call_id[..]),
            Seed::from(&cr_bump_seed[..]),
        ];
        create_account(
            settler_signer,
            call_record_acct,
            cr_lamports,
            CallRecord::LEN as u64,
            &crate::ID,
            &cr_signer_seeds,
        )?;

        // Outcome accumulators — written into the CallRecord at the end of
        // the per-event block. We start optimistic and downgrade as failures
        // arise (codex 2026-05-05 review fix: per-event SettlementStatus).
        let mut status: u8 = SettlementStatus::Settled as u8;
        let mut actual_refund_lamports: u64 = 0;

        // ----- Step 3: premium-in via SettlementAuthority delegate -----
        // SPL Token Transfer with authority = SettlementAuthority PDA, signed
        // via invoke_signed. Token program checks that the source account's
        // delegate field equals authority.address() and delegated_amount >=
        // amount; both are set off-chain by the agent via SPL `Approve`.
        //
        // codex 2026-05-05: if the agent has revoked the delegate, the
        // delegate field is None or doesn't match, or delegated_amount is
        // insufficient — we want to mark the call record DelegateFailed and
        // continue with the next event instead of aborting the whole batch.
        //
        // Pinocchio's CPI wrapper does NOT translate `sol_invoke_signed_c`
        // failure codes into `Err(...)` — when a CPI fails, the parent
        // program is forced to fail too. So we cannot use a try/catch on
        // the SPL Token Transfer. Instead we PRE-FLIGHT check the delegate
        // fields directly off the agent ATA buffer; if they don't satisfy
        // the SPL Token contract, we skip the CPI entirely. This matches
        // the production behaviour exactly: SPL Token would reject the
        // same way, and now we can recover.
        //
        // SPL Token account layout offsets:
        //   72..76:  delegate option discriminant (u32 LE; 0 = None, 1 = Some)
        //   76..108: delegate pubkey (only valid when discriminant == 1)
        //   108:     state byte (1 = initialised)
        //   121..129: delegated_amount u64 LE
        let delegate_ok = {
            let ata_data = agent_ata_acct.try_borrow()?;
            if ata_data.len() < 165 || ata_data[108] != 1 {
                false
            } else {
                let opt = u32::from_le_bytes(ata_data[72..76].try_into().unwrap());
                if opt != 1 {
                    false
                } else {
                    let mut delegate_bytes = [0u8; 32];
                    delegate_bytes.copy_from_slice(&ata_data[76..108]);
                    let delegated_amount =
                        u64::from_le_bytes(ata_data[121..129].try_into().unwrap());
                    let delegate_addr =
                        solana_address::Address::new_from_array(delegate_bytes);
                    delegate_addr == *settlement_auth.address()
                        && delegated_amount >= premium_lamports
                }
            }
        };

        let sa_bump_seed = [sa_bump];
        let sa_signer_seeds: [Seed; 2] = [
            Seed::from(SEED_SETTLEMENT_AUTHORITY),
            Seed::from(&sa_bump_seed[..]),
        ];
        if delegate_ok {
            transfer_pda_signed(
                agent_ata_acct,
                pool_vault_acct,
                settlement_auth,
                premium_lamports,
                &sa_signer_seeds,
            )?;
        }
        let premium_in_ok = delegate_ok;

        if !premium_in_ok {
            status = SettlementStatus::DelegateFailed as u8;
            // Write CallRecord and move on.
            {
                let mut cr_data = call_record_acct.try_borrow_mut()?;
                let record: &mut CallRecord =
                    bytemuck::from_bytes_mut(&mut cr_data[..CallRecord::LEN]);
                record.bump = cr_bump;
                record.breach = breach;
                record.settlement_status = status;
                record._padding0 = [0; 5];
                record.call_id = call_id;
                record.agent = solana_address::Address::new_from_array(agent_owner);
                record.endpoint_slug = endpoint_slug;
                record.premium_lamports = premium_lamports;
                record.refund_lamports = refund_lamports;
                record.actual_refund_lamports = 0;
                record.latency_ms = latency_ms;
                record._padding1 = [0; 4];
                record.timestamp = timestamp;
            }
            acct_cursor += needed_for_event;
            continue;
        }

        // Pool credit (gross).
        {
            let mut pool_data = pool_acct.try_borrow_mut()?;
            let cp: &mut CoveragePool = bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
            cp.current_balance = cp
                .current_balance
                .checked_add(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
            cp.total_premiums = cp
                .total_premiums
                .checked_add(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
        }

        // Endpoint stats + hourly exposure cap.
        //
        // The cap is consulted inside the same borrow block so we can both
        // reset the period if a new hour started AND adjust the requested
        // refund (clamping to remaining cap). When the cap clamps the
        // payout to a smaller-than-requested amount we mark the record
        // ExposureCapClamped so the indexer can surface the gap explicitly
        // (codex 2026-05-05 review fix: previously the program silently
        // zeroed the refund without recording the reason).
        let mut intended_refund_after_cap = refund_lamports;
        {
            let mut ep_data = endpoint_acct.try_borrow_mut()?;
            let ep: &mut EndpointConfig =
                bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
            ep.total_calls = ep.total_calls.checked_add(1).ok_or(PactError::ArithmeticOverflow)?;
            ep.total_premiums = ep
                .total_premiums
                .checked_add(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
            if breach != 0 {
                ep.total_breaches = ep
                    .total_breaches
                    .checked_add(1)
                    .ok_or(PactError::ArithmeticOverflow)?;
            }
            if now > ep.current_period_start + 3600 {
                ep.current_period_start = now;
                ep.current_period_refunds = 0;
            }
            if intended_refund_after_cap > 0 {
                let cap_remaining = ep
                    .exposure_cap_per_hour_lamports
                    .saturating_sub(ep.current_period_refunds);
                if intended_refund_after_cap > cap_remaining {
                    // Clamp to whatever cap is left (may be 0).
                    intended_refund_after_cap = cap_remaining;
                    status = SettlementStatus::ExposureCapClamped as u8;
                }
                if intended_refund_after_cap > 0 {
                    ep.current_period_refunds = ep
                        .current_period_refunds
                        .checked_add(intended_refund_after_cap)
                        .ok_or(PactError::ArithmeticOverflow)?;
                }
            }
        }

        // ----- Step 4: fee fan-out from pool -----
        let pool_bump_seed = [pool_bump];
        let pool_signer_seeds: [Seed; 3] = [
            Seed::from(SEED_COVERAGE_POOL),
            Seed::from(&endpoint_slug[..]),
            Seed::from(&pool_bump_seed[..]),
        ];

        let mut total_fee_paid: u64 = 0;
        for j in 0..ep_count {
            let bps = fee_recipients_snapshot[j].bps as u128;
            let fee_amount = (premium_lamports as u128 * bps / 10_000u128) as u64;
            if fee_amount == 0 {
                continue;
            }
            let dest = &accounts[fee_atas_base + j];
            transfer_pda_signed(
                pool_vault_acct,
                dest,
                pool_acct,
                fee_amount,
                &pool_signer_seeds,
            )?;
            total_fee_paid = total_fee_paid
                .checked_add(fee_amount)
                .ok_or(PactError::ArithmeticOverflow)?;
        }
        // Debit pool current_balance by fees paid (residual stays in pool).
        if total_fee_paid > 0 {
            let mut pool_data = pool_acct.try_borrow_mut()?;
            let cp: &mut CoveragePool = bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
            cp.current_balance = cp
                .current_balance
                .checked_sub(total_fee_paid)
                .ok_or(PactError::ArithmeticOverflow)?;
        }

        // ----- Step 5: refund (on breach) — pool → agent_ata -----
        if intended_refund_after_cap > 0 {
            let pool_balance = {
                let pool_data = pool_acct.try_borrow()?;
                let cp: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
                cp.current_balance
            };
            if pool_balance < intended_refund_after_cap {
                // codex 2026-05-05 review fix (audit H-11): instead of
                // silently dropping the refund, mark PoolDepleted on the
                // CallRecord so the indexer + ops can see the gap.
                // Premium and fees already settled; we just don't transfer
                // the refund.
                status = SettlementStatus::PoolDepleted as u8;
                actual_refund_lamports = 0;
            } else {
                transfer_pda_signed(
                    pool_vault_acct,
                    agent_ata_acct,
                    pool_acct,
                    intended_refund_after_cap,
                    &pool_signer_seeds,
                )?;
                actual_refund_lamports = intended_refund_after_cap;
                {
                    let mut pool_data = pool_acct.try_borrow_mut()?;
                    let cp: &mut CoveragePool =
                        bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
                    cp.current_balance = cp
                        .current_balance
                        .checked_sub(actual_refund_lamports)
                        .ok_or(PactError::ArithmeticOverflow)?;
                    cp.total_refunds = cp
                        .total_refunds
                        .checked_add(actual_refund_lamports)
                        .ok_or(PactError::ArithmeticOverflow)?;
                }
                {
                    let mut ep_data = endpoint_acct.try_borrow_mut()?;
                    let ep: &mut EndpointConfig =
                        bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
                    ep.total_refunds = ep
                        .total_refunds
                        .checked_add(actual_refund_lamports)
                        .ok_or(PactError::ArithmeticOverflow)?;
                }
            }
        }

        // Finally, write the CallRecord with the final status + actual amount.
        {
            let mut cr_data = call_record_acct.try_borrow_mut()?;
            let record: &mut CallRecord =
                bytemuck::from_bytes_mut(&mut cr_data[..CallRecord::LEN]);
            record.bump = cr_bump;
            record.breach = breach;
            record.settlement_status = status;
            record._padding0 = [0; 5];
            record.call_id = call_id;
            record.agent = solana_address::Address::new_from_array(agent_owner);
            record.endpoint_slug = endpoint_slug;
            record.premium_lamports = premium_lamports;
            record.refund_lamports = refund_lamports;
            record.actual_refund_lamports = actual_refund_lamports;
            record.latency_ms = latency_ms;
            record._padding1 = [0; 4];
            record.timestamp = timestamp;
        }

        acct_cursor += needed_for_event;
    }

    Ok(())
}
