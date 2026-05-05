/// settle_batch — processes up to MAX_BATCH_SIZE settlement events.
///
/// Account list:
///   0:  settlement_authority signer (writable for rent if needed)
///   1:  settlement_authority PDA (readonly)
///   2:  coverage_pool PDA (writable)
///   3:  coverage_pool USDC vault (writable)
///   4:  token_program
///   5:  system_program
///   6:  clock sysvar (unused directly — Clock::get() syscall used instead)
///   Then per event (4 accounts each):
///     [call_record PDA (writable, init), agent_wallet PDA (writable),
///      agent_wallet vault (writable), endpoint_config PDA (writable)]
///
/// Data layout:
///   0-1:  event_count u16 LE
///   per event (100 bytes):
///     0-15:   call_id [u8; 16]
///     16-47:  agent_wallet pubkey [u8; 32]
///     48-63:  endpoint_slug [u8; 16]
///     64-71:  premium_lamports u64
///     72-79:  refund_lamports u64
///     80-83:  latency_ms u32
///     84:     breach u8
///     85-91:  _pad [u8; 7]
///     92-99:  timestamp i64
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    constants::{MAX_BATCH_SIZE, MIN_PREMIUM_LAMPORTS},
    error::PactError,
    pda::{
        derive_agent_wallet, derive_call_record, derive_endpoint_config,
        SEED_AGENT_WALLET, SEED_CALL, SEED_COVERAGE_POOL,
    },
    state::{AgentWallet, CallRecord, CoveragePool, EndpointConfig, SettlementAuthority},
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{transfer_pda_signed, SPL_TOKEN_PROGRAM_ID},
};

const FIXED_ACCOUNTS: usize = 7;
const ACCOUNTS_PER_EVENT: usize = 4;
const BYTES_PER_EVENT: usize = 100;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < FIXED_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let settler_signer = &accounts[0];
    let settlement_auth = &accounts[1];
    let pool = &accounts[2];
    let pool_vault = &accounts[3];
    let token_program = &accounts[4];
    let system_program = &accounts[5];

    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !settler_signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify settler signer matches settlement_authority.signer
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
    }

    let event_count = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    if event_count > MAX_BATCH_SIZE {
        return Err(PactError::BatchTooLarge.into());
    }
    if data.len() < 2 + event_count * BYTES_PER_EVENT {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < FIXED_ACCOUNTS + event_count * ACCOUNTS_PER_EVENT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let now = Clock::get()?.unix_timestamp;
    let rent = Rent::get()?;

    for i in 0..event_count {
        let ev_start = 2 + i * BYTES_PER_EVENT;
        let ev = &data[ev_start..ev_start + BYTES_PER_EVENT];

        let call_id: [u8; 16] = ev[0..16].try_into().unwrap();
        let agent_wallet_key: [u8; 32] = ev[16..48].try_into().unwrap();
        let endpoint_slug: [u8; 16] = ev[48..64].try_into().unwrap();
        let premium_lamports = u64::from_le_bytes(ev[64..72].try_into().unwrap());
        let mut refund_lamports = u64::from_le_bytes(ev[72..80].try_into().unwrap());
        let latency_ms = u32::from_le_bytes(ev[80..84].try_into().unwrap());
        let breach = ev[84];
        let timestamp = i64::from_le_bytes(ev[92..100].try_into().unwrap());

        // Validate
        if timestamp > now {
            return Err(PactError::InvalidTimestamp.into());
        }
        if premium_lamports < MIN_PREMIUM_LAMPORTS {
            return Err(PactError::PremiumTooSmall.into());
        }

        let base = FIXED_ACCOUNTS + i * ACCOUNTS_PER_EVENT;
        let call_record_acct = &accounts[base];
        let agent_wallet_acct = &accounts[base + 1];
        let agent_vault_acct = &accounts[base + 2];
        let endpoint_acct = &accounts[base + 3];

        // Verify PDAs
        let (expected_call_record, cr_bump) = derive_call_record(&call_id);
        if call_record_acct.address() != &expected_call_record {
            return Err(ProgramError::InvalidSeeds);
        }

        use solana_address::Address;
        let aw_addr = Address::new_from_array(agent_wallet_key);
        let (expected_aw, _) = derive_agent_wallet(&aw_addr);
        if agent_wallet_acct.address() != &expected_aw {
            return Err(ProgramError::InvalidSeeds);
        }

        let (expected_ep, _) = derive_endpoint_config(&endpoint_slug);
        if endpoint_acct.address() != &expected_ep {
            return Err(ProgramError::InvalidSeeds);
        }

        // Check for duplicate: call_record must be uninitialized
        if !call_record_acct.is_data_empty() {
            return Err(PactError::DuplicateCallId.into());
        }

        // Check endpoint not paused
        {
            let ep_data = endpoint_acct.try_borrow()?;
            if ep_data.len() < EndpointConfig::LEN {
                return Err(ProgramError::InvalidAccountData);
            }
            let ep: &EndpointConfig = bytemuck::from_bytes(&ep_data[..EndpointConfig::LEN]);
            if ep.paused != 0 {
                return Err(PactError::EndpointPaused.into());
            }
        }

        // Hourly exposure cap — read then update
        {
            let mut ep_data = endpoint_acct.try_borrow_mut()?;
            let ep: &mut EndpointConfig =
                bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);

            // Reset period if more than 1 hour has elapsed
            if now > ep.current_period_start + 3600 {
                ep.current_period_start = now;
                ep.current_period_refunds = 0;
            }

            if refund_lamports > 0 {
                let cap_remaining = ep
                    .exposure_cap_per_hour_lamports
                    .saturating_sub(ep.current_period_refunds);
                if refund_lamports > cap_remaining {
                    refund_lamports = 0; // cap exceeded — skip refund
                } else {
                    ep.current_period_refunds = ep
                        .current_period_refunds
                        .checked_add(refund_lamports)
                        .ok_or(PactError::ArithmeticOverflow)?;
                }
            }
        }

        // Allocate CallRecord PDA
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

        // Write CallRecord
        {
            let mut cr_data = call_record_acct.try_borrow_mut()?;
            let record: &mut CallRecord =
                bytemuck::from_bytes_mut(&mut cr_data[..CallRecord::LEN]);
            record.bump = cr_bump;
            record.breach = breach;
            record.call_id = call_id;
            record.agent_wallet = *agent_wallet_acct.address();
            record.endpoint_slug = endpoint_slug;
            record.premium_lamports = premium_lamports;
            record.refund_lamports = refund_lamports;
            record.latency_ms = latency_ms;
            record.timestamp = timestamp;
        }

        // Read agent wallet bump for PDA signing
        let aw_bump;
        {
            let aw_data = agent_wallet_acct.try_borrow()?;
            let aw: &AgentWallet = bytemuck::from_bytes(&aw_data[..AgentWallet::LEN]);
            aw_bump = aw.bump;
            if aw.balance < premium_lamports {
                return Err(PactError::InsufficientBalance.into());
            }
        }

        // CPI: Transfer premium — agent vault → pool vault (signed by agent_wallet PDA)
        let aw_bump_seed = [aw_bump];
        let aw_signer_seeds: [Seed; 3] = [
            Seed::from(SEED_AGENT_WALLET),
            Seed::from(&agent_wallet_key[..]),
            Seed::from(&aw_bump_seed[..]),
        ];
        transfer_pda_signed(
            agent_vault_acct,
            pool_vault,
            agent_wallet_acct,
            premium_lamports,
            &aw_signer_seeds,
        )?;

        // Update agent wallet
        {
            let mut aw_data = agent_wallet_acct.try_borrow_mut()?;
            let aw: &mut AgentWallet = bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);
            aw.balance = aw
                .balance
                .checked_sub(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
            aw.total_premiums_paid = aw
                .total_premiums_paid
                .checked_add(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
            aw.call_count = aw
                .call_count
                .checked_add(1)
                .ok_or(PactError::ArithmeticOverflow)?;
        }

        // Update pool
        {
            let mut pool_data = pool.try_borrow_mut()?;
            let pool_state: &mut CoveragePool =
                bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
            pool_state.current_balance = pool_state
                .current_balance
                .checked_add(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
            pool_state.total_premiums = pool_state
                .total_premiums
                .checked_add(premium_lamports)
                .ok_or(PactError::ArithmeticOverflow)?;
        }

        // Update endpoint stats
        {
            let mut ep_data = endpoint_acct.try_borrow_mut()?;
            let ep: &mut EndpointConfig =
                bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
            ep.total_calls = ep
                .total_calls
                .checked_add(1)
                .ok_or(PactError::ArithmeticOverflow)?;
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
        }

        // Handle refund if applicable
        if refund_lamports > 0 {
            // Check pool has enough
            let pool_balance = {
                let pool_data = pool.try_borrow()?;
                let pool_state: &CoveragePool =
                    bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
                pool_state.current_balance
            };

            if pool_balance < refund_lamports {
                // Pool depleted — skip refund silently, premium already settled
                continue;
            }

            // Read pool bump for PDA signing
            let pool_bump = {
                let pool_data = pool.try_borrow()?;
                let ps: &CoveragePool = bytemuck::from_bytes(&pool_data[..CoveragePool::LEN]);
                ps.bump
            };

            // CPI: Transfer refund — pool vault → agent vault (signed by pool PDA)
            let pool_bump_seed = [pool_bump];
            let pool_signer_seeds: [Seed; 2] = [
                Seed::from(SEED_COVERAGE_POOL),
                Seed::from(&pool_bump_seed[..]),
            ];
            transfer_pda_signed(
                pool_vault,
                agent_vault_acct,
                pool,
                refund_lamports,
                &pool_signer_seeds,
            )?;

            // Update pool and agent for refund
            {
                let mut pool_data = pool.try_borrow_mut()?;
                let pool_state: &mut CoveragePool =
                    bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
                pool_state.current_balance = pool_state
                    .current_balance
                    .checked_sub(refund_lamports)
                    .ok_or(PactError::ArithmeticOverflow)?;
                pool_state.total_refunds = pool_state
                    .total_refunds
                    .checked_add(refund_lamports)
                    .ok_or(PactError::ArithmeticOverflow)?;
            }
            {
                let mut aw_data = agent_wallet_acct.try_borrow_mut()?;
                let aw: &mut AgentWallet =
                    bytemuck::from_bytes_mut(&mut aw_data[..AgentWallet::LEN]);
                aw.balance = aw
                    .balance
                    .checked_add(refund_lamports)
                    .ok_or(PactError::ArithmeticOverflow)?;
                aw.total_refunds_received = aw
                    .total_refunds_received
                    .checked_add(refund_lamports)
                    .ok_or(PactError::ArithmeticOverflow)?;
            }
            {
                let mut ep_data = endpoint_acct.try_borrow_mut()?;
                let ep: &mut EndpointConfig =
                    bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
                ep.total_refunds = ep
                    .total_refunds
                    .checked_add(refund_lamports)
                    .ok_or(PactError::ArithmeticOverflow)?;
            }
        }
    }

    Ok(())
}
