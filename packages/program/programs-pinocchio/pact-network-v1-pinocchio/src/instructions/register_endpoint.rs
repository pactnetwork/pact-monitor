/// register_endpoint — atomically registers an endpoint AND creates its
/// per-slug CoveragePool PDA + USDC vault. Step C/A folds the standalone
/// initialize_coverage_pool instruction into this entry point so an
/// endpoint can never exist without its pool.
///
/// Accounts:
///   0. authority         — signer, writable (must equal ProtocolConfig.authority)
///   1. protocol_config   — readonly, must already be initialized
///   2. treasury          — readonly (singleton). Used only when fee_recipients
///                          contain a Treasury entry — its USDC vault is copied
///                          into the entry's destination at substitution time.
///   3. endpoint_config   — writable, PDA [b"endpoint", slug], created here
///   4. coverage_pool     — writable, PDA [b"coverage_pool", slug], created here
///   5. pool_vault        — writable, pre-allocated 165-byte token account
///                          (owner = SPL Token program); initialized here
///   6. usdc_mint         — readonly
///   7. system_program
///   8. token_program
///   9..9+M. affiliate_ata_0..affiliate_ata_M-1 — readonly, one per
///           AffiliateAta entry in fee_recipients (in the order they appear
///           in the array). Each is verified to be a 165-byte SPL Token
///           account on the protocol USDC mint with matching destination.
///           (codex 2026-05-05 review fix.)
///
/// Data layout (variable):
///   0-15:    slug [u8; 16]
///   16-23:   flat_premium_lamports u64
///   24-25:   percent_bps u16
///   26-29:   sla_latency_ms u32
///   30-37:   imputed_cost_lamports u64
///   38-45:   exposure_cap_per_hour_lamports u64
///   46:      fee_recipients_present u8 (0 = use ProtocolConfig defaults)
///   47:      fee_recipient_count u8 (0..=8) — only meaningful when present=1
///   48..:    `count` * 48 bytes of FeeRecipient entries (only when present=1)
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    constants::MAX_FEE_RECIPIENTS,
    error::PactError,
    fee::{
        parse_and_validate, substitute_treasury_destination, validate_affiliate_atas,
        validate_post_substitution, FEE_RECIPIENT_WIRE_LEN,
    },
    pda::{
        derive_coverage_pool, derive_endpoint_config, verify_protocol_config, verify_treasury,
        SEED_COVERAGE_POOL, SEED_ENDPOINT,
    },
    state::{CoveragePool, EndpointConfig, FeeRecipient, FeeRecipientKind, ProtocolConfig, Treasury},
    system::{create_account, SYSTEM_PROGRAM_ID},
    token::{initialize_account3, SPL_TOKEN_PROGRAM_ID},
};

const ACCOUNT_COUNT: usize = 9;
const HEADER_LEN: usize = 46;

pub fn process(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < ACCOUNT_COUNT {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < HEADER_LEN + 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let protocol_config = &accounts[1];
    let treasury = &accounts[2];
    let endpoint = &accounts[3];
    let pool = &accounts[4];
    let pool_vault = &accounts[5];
    let mint = &accounts[6];
    let system_program = &accounts[7];
    let token_program = &accounts[8];

    if system_program.address() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if token_program.address() != &SPL_TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !authority.is_writable()
        || !endpoint.is_writable()
        || !pool.is_writable()
        || !pool_vault.is_writable()
    {
        return Err(ProgramError::InvalidAccountData);
    }

    // SECURITY: verify ProtocolConfig + Treasury are the canonical PDAs +
    // program-owned BEFORE reading any fields. (codex 2026-05-05 mainnet
    // blocker.)
    verify_protocol_config(protocol_config)?;
    verify_treasury(treasury)?;

    // Verify caller is ProtocolConfig.authority and mint matches.
    let max_total_fee_bps;
    let pc_default_count;
    let pc_default_recipients;
    let protocol_usdc_mint;
    {
        let pc_data = protocol_config.try_borrow()?;
        if pc_data.len() < ProtocolConfig::LEN {
            return Err(PactError::ProtocolConfigNotInitialized.into());
        }
        let pc: &ProtocolConfig = bytemuck::from_bytes(&pc_data[..ProtocolConfig::LEN]);
        if &pc.authority != authority.address() {
            return Err(PactError::UnauthorizedAuthority.into());
        }
        if &pc.usdc_mint != mint.address() {
            return Err(PactError::FeeRecipientInvalidUsdcMint.into());
        }
        max_total_fee_bps = pc.max_total_fee_bps;
        pc_default_count = pc.default_fee_recipient_count as usize;
        pc_default_recipients = pc.default_fee_recipients;
        protocol_usdc_mint = pc.usdc_mint;
    }

    // Read Treasury vault address (used to substitute Treasury-kind entries).
    let treasury_vault = {
        let t_data = treasury.try_borrow()?;
        if t_data.len() < Treasury::LEN {
            return Err(PactError::TreasuryNotInitialized.into());
        }
        let t: &Treasury = bytemuck::from_bytes(&t_data[..Treasury::LEN]);
        t.usdc_vault
    };

    // Parse header
    let slug: [u8; 16] = data[0..16].try_into().unwrap();
    for &b in slug.iter() {
        if b != 0 && (b < 0x20 || b > 0x7E) {
            return Err(PactError::InvalidSlug.into());
        }
    }
    let flat_premium_lamports = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let percent_bps = u16::from_le_bytes(data[24..26].try_into().unwrap());
    let sla_latency_ms = u32::from_le_bytes(data[26..30].try_into().unwrap());
    let imputed_cost_lamports = u64::from_le_bytes(data[30..38].try_into().unwrap());
    let exposure_cap_per_hour_lamports =
        u64::from_le_bytes(data[38..46].try_into().unwrap());

    // Recipient parsing
    let recipients_present = data[HEADER_LEN];
    let req_count = data[HEADER_LEN + 1] as usize;

    let (mut entries, count): ([FeeRecipient; MAX_FEE_RECIPIENTS], usize) = if recipients_present
        == 1
    {
        let body_off = HEADER_LEN + 2;
        let needed = body_off + req_count * FEE_RECIPIENT_WIRE_LEN;
        if data.len() < needed {
            return Err(ProgramError::InvalidInstructionData);
        }
        let (entries, _sum) = parse_and_validate(&data[body_off..], req_count, max_total_fee_bps)?;
        (entries, req_count)
    } else {
        // Copy defaults from ProtocolConfig.
        if pc_default_count > MAX_FEE_RECIPIENTS {
            // Should be unreachable given how PC is initialized.
            return Err(PactError::FeeRecipientArrayTooLong.into());
        }
        (pc_default_recipients, pc_default_count)
    };

    // Substitute Treasury destinations with the canonical Treasury USDC vault.
    substitute_treasury_destination(&mut entries, count, &treasury_vault);

    // codex 2026-05-05: tighten fee-recipient validation.
    //
    // (1) After substitution: enforce exactly-one Treasury, Treasury bps > 0,
    //     and re-run duplicate detection (now Treasury holds the canonical
    //     vault, so a smuggled AffiliateAta-pointing-at-Treasury is caught).
    validate_post_substitution(&entries, count)?;

    // (2) Collect AffiliateAta accounts from the tail of the account list
    //     and validate each one is a real, initialised SPL Token account on
    //     the protocol USDC mint with a matching destination address.
    let mut affiliate_count = 0usize;
    for i in 0..count {
        if entries[i].kind == FeeRecipientKind::AffiliateAta as u8 {
            affiliate_count += 1;
        }
    }
    if accounts.len() < ACCOUNT_COUNT + affiliate_count {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if affiliate_count > 0 {
        let mut affiliate_atas: [&AccountView; MAX_FEE_RECIPIENTS] = [&accounts[0]; MAX_FEE_RECIPIENTS];
        for k in 0..affiliate_count {
            affiliate_atas[k] = &accounts[ACCOUNT_COUNT + k];
        }
        validate_affiliate_atas(
            &entries,
            count,
            &affiliate_atas[..affiliate_count],
            &protocol_usdc_mint,
        )?;
    }

    // Verify endpoint and pool PDAs.
    let (expected_ep, ep_bump) = derive_endpoint_config(&slug);
    if endpoint.address() != &expected_ep {
        return Err(ProgramError::InvalidSeeds);
    }
    if !endpoint.is_data_empty() {
        return Err(PactError::EndpointAlreadyRegistered.into());
    }

    let (expected_pool, pool_bump) = derive_coverage_pool(&slug);
    if pool.address() != &expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }
    if !pool.is_data_empty() {
        return Err(PactError::EndpointAlreadyRegistered.into());
    }

    let rent = Rent::get()?;

    // Allocate CoveragePool PDA
    {
        let lamports = rent.try_minimum_balance(CoveragePool::LEN)?;
        let bump_seed = [pool_bump];
        let signer_seeds: [Seed; 3] = [
            Seed::from(SEED_COVERAGE_POOL),
            Seed::from(&slug[..]),
            Seed::from(&bump_seed[..]),
        ];
        create_account(
            authority,
            pool,
            lamports,
            CoveragePool::LEN as u64,
            &crate::ID,
            &signer_seeds,
        )?;
    }

    // Bind pool vault
    initialize_account3(pool_vault, mint, pool.address())?;

    // Allocate EndpointConfig PDA
    {
        let lamports = rent.try_minimum_balance(EndpointConfig::LEN)?;
        let bump_seed = [ep_bump];
        let signer_seeds: [Seed; 3] = [
            Seed::from(SEED_ENDPOINT),
            Seed::from(&slug[..]),
            Seed::from(&bump_seed[..]),
        ];
        create_account(
            authority,
            endpoint,
            lamports,
            EndpointConfig::LEN as u64,
            &crate::ID,
            &signer_seeds,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;

    // Write CoveragePool state
    {
        let mut pool_data = pool.try_borrow_mut()?;
        let cp: &mut CoveragePool = bytemuck::from_bytes_mut(&mut pool_data[..CoveragePool::LEN]);
        cp.bump = pool_bump;
        cp._padding0 = [0; 7];
        cp.authority = *authority.address();
        cp.usdc_mint = *mint.address();
        cp.usdc_vault = *pool_vault.address();
        cp.endpoint_slug = slug;
        cp.total_deposits = 0;
        cp.total_premiums = 0;
        cp.total_refunds = 0;
        cp.current_balance = 0;
        cp.created_at = now;
    }

    // Write EndpointConfig state
    {
        let mut ep_data = endpoint.try_borrow_mut()?;
        let state: &mut EndpointConfig =
            bytemuck::from_bytes_mut(&mut ep_data[..EndpointConfig::LEN]);
        state.bump = ep_bump;
        state.paused = 0;
        state._padding0 = [0; 6];
        state.slug = slug;
        state.flat_premium_lamports = flat_premium_lamports;
        state.percent_bps = percent_bps;
        state._padding1 = [0; 6];
        state.sla_latency_ms = sla_latency_ms;
        state._padding2 = [0; 4];
        state.imputed_cost_lamports = imputed_cost_lamports;
        state.exposure_cap_per_hour_lamports = exposure_cap_per_hour_lamports;
        state.current_period_start = now;
        state.current_period_refunds = 0;
        state.total_calls = 0;
        state.total_breaches = 0;
        state.total_premiums = 0;
        state.total_refunds = 0;
        state.last_updated = now;
        state.coverage_pool = *pool.address();
        state.fee_recipient_count = count as u8;
        state._padding3 = [0; 7];
        state.fee_recipients = entries;
    }

    Ok(())
}
