# Pact Market V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Pact Market V1 — a parametric API insurance proxy on Solana — to public devnet by Wed May 6, mainnet by Mon May 11 (Colosseum submission).

**Architecture:** Five-unit system on GCP. Cloud Run services for proxy (Hono), settler (NestJS), indexer (NestJS); Pub/Sub event queue between proxy and settler; Cloud SQL Postgres for per-call history; Vercel-hosted Next.js dashboard; new `pact-market-pinocchio` Pinocchio crate on Solana. Settlement authority hot key stored in GCP Secret Manager. Agent custody is via SPL Token approval (spec §3.1.2): the agent grants `SettlementAuthority` PDA a spending allowance on their own USDC ATA (one wallet click); `settle_batch` debits the agent ATA via SPL delegate authority and, on breach, transfers the refund directly back to the agent's USDC ATA — no `claim_refund` step, no `AgentWallet` PDA, no auto-claim flow.

**Tech Stack:** Pinocchio 0.10 (Rust), TypeScript everywhere else. Hono 4 + Cloudflare-Workers-style API on Cloud Run. NestJS 10 + Prisma 5 + Postgres 16. Next.js 15 + Tailwind 4 + shadcn + `@solana/wallet-adapter-react`. `@solana/kit` 2 + Codama for client code. `@google-cloud/pubsub` + `@google-cloud/secret-manager`. pnpm workspaces, Turborepo, Vitest, LiteSVM (Bun), surfpool.

**Spec:** `docs/superpowers/specs/2026-05-05-pact-market-execution-design.md`

**Branching:** All work branches off `develop`. Each wave-1 stream gets its own feature branch. Captain integrates on Wed PM.

---

## Layer legend

This plan is annotated with two layer tags so future contributors know where each piece sits in the eventual product split:

- **[Network rails]** — the trust-minimised insurance protocol: the on-chain program, the settler that drives it, the indexer + DB that feeds the public scorecard, and any generic agent-side surfaces (CLI, SDK wrappers). This layer is the public good; anyone — Pact's own market or a third party — can build a market interface on top of it.
- **[Market interface]** — Pact's first commercial product on top of the rails: the proxy that sits in front of upstream APIs, the dashboard customers actually log into, billing/quotas, refund-claim UX. A market interface is one possible consumer of the rails; it is **not** required for the rails to work.

Waves that don't fit cleanly into one layer are tagged **[infra]** (cross-cutting GCP/DNS/keys) or **[cross-cutting]** (integration, ops, submission).

For the renaming and re-org that makes this split explicit, see `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md`.

---

## Wave 0 — GCP project + secrets bootstrap [infra]

**Owner:** Captain. Sequential, blocks all wave 1 deploys (but not local dev).

### Task 0.1: Create or claim GCP project

**Files:** none in repo; out-of-band setup.

- [ ] **Step 1:** Confirm with Rick which GCP project ID to use (or get permission to create one named `pact-network-v1`).
- [ ] **Step 2:** Set local default: `gcloud config set project <PROJECT_ID>`.
- [ ] **Step 3:** Enable required APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  pubsub.googleapis.com \
  secretmanager.googleapis.com \
  dns.googleapis.com \
  iamcredentials.googleapis.com \
  artifactregistry.googleapis.com
```

- [ ] **Step 4:** Verify all APIs enabled: `gcloud services list --enabled | grep -E 'run|sql|pubsub|secret|dns|iam|artifact'` — expect 7 lines.

### Task 0.2: Create Pub/Sub topic + subscriptions

- [ ] **Step 1:** Create topic and pull subscription:

```bash
gcloud pubsub topics create pact-settle-events
gcloud pubsub subscriptions create pact-settle-events-settler \
  --topic=pact-settle-events \
  --ack-deadline=30 \
  --message-retention-duration=24h
```

- [ ] **Step 2:** Verify: `gcloud pubsub topics list | grep pact-settle-events` and `gcloud pubsub subscriptions list | grep pact-settle-events-settler`.

### Task 0.3: Create Cloud SQL Postgres instance (devnet)

- [ ] **Step 1:** Create db-f1-micro instance (cheapest) in us-east1:

```bash
gcloud sql instances create pact-pg-dev \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=us-east1 \
  --storage-size=10GB \
  --storage-type=SSD
```

- [ ] **Step 2:** Set postgres password (record in 1Password as `pact-pg-dev-postgres`):

```bash
gcloud sql users set-password postgres --instance=pact-pg-dev --password=<RANDOM_32_CHAR>
```

- [ ] **Step 3:** Create database:

```bash
gcloud sql databases create pact_market --instance=pact-pg-dev
```

- [ ] **Step 4:** Get connection string for local dev (using Cloud SQL Auth Proxy):

```bash
gcloud sql instances describe pact-pg-dev --format='value(connectionName)'
# format: <project>:us-east1:pact-pg-dev
```

### Task 0.4: Create service accounts

- [ ] **Step 1:** Create three service accounts (proxy, settler, indexer):

```bash
for sa in pact-proxy pact-settler pact-indexer; do
  gcloud iam service-accounts create $sa --display-name="Pact Market $sa"
done
```

- [ ] **Step 2:** Grant Pub/Sub publisher to proxy:

```bash
gcloud pubsub topics add-iam-policy-binding pact-settle-events \
  --member="serviceAccount:pact-proxy@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

- [ ] **Step 3:** Grant Pub/Sub subscriber to settler:

```bash
gcloud pubsub subscriptions add-iam-policy-binding pact-settle-events-settler \
  --member="serviceAccount:pact-settler@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"
```

- [ ] **Step 4:** Grant Cloud SQL client to proxy + indexer:

```bash
for sa in pact-proxy pact-indexer; do
  gcloud projects add-iam-policy-binding $(gcloud config get-value project) \
    --member="serviceAccount:$sa@$(gcloud config get-value project).iam.gserviceaccount.com" \
    --role="roles/cloudsql.client"
done
```

### Task 0.5: Generate + store settlement_authority key in Secret Manager

- [ ] **Step 1:** Generate fresh devnet keypair:

```bash
solana-keygen new --no-bip39-passphrase --silent --outfile /tmp/settlement-authority-devnet.json
SETTLEMENT_AUTHORITY_PUBKEY=$(solana address -k /tmp/settlement-authority-devnet.json)
echo "Pubkey: $SETTLEMENT_AUTHORITY_PUBKEY"
```

- [ ] **Step 2:** Encode keypair as base58:

```bash
SETTLEMENT_AUTHORITY_KEY=$(node -e "console.log(require('bs58').default.encode(Buffer.from(JSON.parse(require('fs').readFileSync('/tmp/settlement-authority-devnet.json')))))")
```

- [ ] **Step 3:** Store in Secret Manager:

```bash
echo -n "$SETTLEMENT_AUTHORITY_KEY" | gcloud secrets create pact-settlement-authority-devnet \
  --data-file=- \
  --replication-policy=automatic
```

- [ ] **Step 4:** Grant settler service account access:

```bash
gcloud secrets add-iam-policy-binding pact-settlement-authority-devnet \
  --member="serviceAccount:pact-settler@$(gcloud config get-value project).iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

- [ ] **Step 5:** Securely shred the local keypair file:

```bash
shred -u /tmp/settlement-authority-devnet.json
```

- [ ] **Step 6:** Backup settlement_authority pubkey + the base58 string in 1Password vault `pact-market-devnet-keys`.

### Task 0.6: Create Artifact Registry repo for Docker images

- [ ] **Step 1:** `gcloud artifacts repositories create pact-market --repository-format=docker --location=us-east1`
- [ ] **Step 2:** Configure local Docker auth: `gcloud auth configure-docker us-east1-docker.pkg.dev`

### Task 0.7: Capture all ids + URLs into a shared env file

- [ ] **Step 1:** Create file `deploy/gcp.env` (gitignored):

```bash
GCP_PROJECT=<from gcloud config get-value project>
GCP_REGION=us-east1
PUBSUB_TOPIC=projects/$GCP_PROJECT/topics/pact-settle-events
PUBSUB_SUBSCRIPTION=projects/$GCP_PROJECT/subscriptions/pact-settle-events-settler
CLOUDSQL_INSTANCE=$GCP_PROJECT:us-east1:pact-pg-dev
PG_URL=postgresql://postgres:<password>@127.0.0.1:5432/pact_market
SETTLEMENT_AUTHORITY_SECRET=projects/$GCP_PROJECT/secrets/pact-settlement-authority-devnet/versions/latest
SETTLEMENT_AUTHORITY_PUBKEY=<from step 0.5.1>
ARTIFACT_REGISTRY=us-east1-docker.pkg.dev/$GCP_PROJECT/pact-market
```

- [ ] **Step 2:** Add `deploy/gcp.env` to `.gitignore` (verify already there or add).
- [ ] **Step 3:** Commit `.gitignore` update:

```bash
git add .gitignore
git commit -m "chore(deploy): gitignore deploy/gcp.env"
```

---

## Wave 1A — `pact-market-pinocchio` program [Network rails]

> **Layering note:** This crate will be renamed to `pact-network-v1-pinocchio` as part of Step B in the layering refactor (see `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md`). The four substantive on-chain changes — per-endpoint coverage pools (§3.1.1), agent custody via SPL Token approval (§3.1.2), interchangeable fee recipients (§3.1.3), and an explicit treasury account — are **part of V1 itself**, not V2 follow-ups. The tasks below describe the V1 design with those changes baked in: no `AgentWallet` PDA, no `deposit_usdc`/`request_withdrawal`/`execute_withdrawal`/`claim_refund` instructions, no `WITHDRAWAL_COOLDOWN_SECS`/`MAX_DEPOSIT_LAMPORTS`. Per-endpoint pools, Treasury + ProtocolConfig accounts, and the channel-then-fan-out `settle_batch` are required for the Wed devnet ship.

**Branch:** `feat/pact-market-program`
**Owner:** Crew agent `program-crew`
**Depends on:** none. Can start immediately.
**Critical path:** YES — settler depends on Codama IDL.

### File structure

```
packages/program/programs-pinocchio/pact-market-pinocchio/
├── Cargo.toml
├── src/
│   ├── lib.rs              # entrypoint + dispatch
│   ├── state.rs            # per-endpoint CoveragePool, EndpointConfig (with fee_recipients), CallRecord, SettlementAuthority, Treasury, ProtocolConfig (NO AgentWallet — §3.1.2)
│   ├── error.rs            # PactError enum 6000..6015 + fee-validation codes
│   ├── pda.rs              # seed derivation helpers (per-endpoint pool seeds)
│   ├── discriminator.rs    # 1-byte instruction discriminators
│   ├── constants.rs        # USDC mint, MAX_BATCH_SIZE, MAX_FEE_RECIPIENTS, MAX_TOTAL_FEE_BPS, MIN_PREMIUM_LAMPORTS
│   ├── token.rs            # SPL Token CPI helpers (vendored if not in pinocchio-token-program)
│   └── instructions/
│       ├── mod.rs
│       ├── initialize_settlement_authority.rs
│       ├── initialize_treasury.rs            # §3.1.3
│       ├── initialize_protocol_config.rs     # §3.1.3
│       ├── register_endpoint.rs              # creates per-endpoint CoveragePool atomically (§3.1.1) + accepts fee_recipients (§3.1.3)
│       ├── update_endpoint_config.rs
│       ├── update_fee_recipients.rs          # §3.1.3
│       ├── pause_endpoint.rs
│       ├── top_up_coverage_pool.rs           # scoped per-endpoint slug (§3.1.1)
│       └── settle_batch.rs                   # pre-flight delegate check, debit agent USDC ATA via SPL delegate, channel-then-fan-out per-recipient transfers, refund direct to agent ATA on breach (§3.1.2 + §3.1.3)
└── tests/
    ├── 01-pool.ts                             # per-endpoint CoveragePool init + isolation
    ├── 02-endpoint.ts                         # register_endpoint (incl. fee_recipients validation)
    ├── 03-approval.ts                         # SPL approval custody happy path + revoked-approval pre-flight DelegateFailed
    ├── 04-fee-fanout.ts                       # §3.1.3 channel-then-fan-out, rounding to pool, validation rejects
    ├── 05-settle-batch.ts                     # mixed-endpoint batch, dedup, refund direct to agent ATA
    ├── 06-pause.ts
    └── 07-exposure-cap.ts
```

### Task 1A.0: Branch + crate scaffold

**Files:** Create `packages/program/programs-pinocchio/pact-market-pinocchio/{Cargo.toml,src/lib.rs}`. Modify `packages/program/Cargo.toml` (workspace members).

- [ ] **Step 1:** From `develop`, create branch:

```bash
git checkout develop
git pull
git checkout -b feat/pact-market-program
```

- [ ] **Step 2:** Copy the existing pact-insurance-pinocchio Cargo.toml as starting point:

```bash
cp packages/program/programs-pinocchio/pact-insurance-pinocchio/Cargo.toml \
   packages/program/programs-pinocchio/pact-market-pinocchio/Cargo.toml
```

- [ ] **Step 3:** Edit `packages/program/programs-pinocchio/pact-market-pinocchio/Cargo.toml`:

```toml
[package]
name = "pact-market-pinocchio"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "pact_market"

[features]
no-entrypoint = []
default = []

[dependencies]
pinocchio = { workspace = true }
pinocchio-system = { workspace = true }
pinocchio-token = { workspace = true }
```

- [ ] **Step 4:** Add the new crate to workspace members in `packages/program/Cargo.toml`:

```toml
# in [workspace] section, members = [...]
"programs-pinocchio/pact-market-pinocchio",
```

- [ ] **Step 5:** Create `src/lib.rs` skeleton:

```rust
#![allow(unexpected_cfgs)]

use pinocchio::{account_info::AccountInfo, entrypoint, ProgramResult};

mod constants;
mod discriminator;
mod error;
mod instructions;
mod pda;
mod state;

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &pinocchio::pubkey::Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (disc, ix_data) = data.split_first().ok_or(pinocchio::program_error::ProgramError::InvalidInstructionData)?;
    match *disc {
        0 => instructions::initialize_settlement_authority::process(program_id, accounts, ix_data),
        1 => instructions::initialize_treasury::process(program_id, accounts, ix_data),
        2 => instructions::initialize_protocol_config::process(program_id, accounts, ix_data),
        3 => instructions::register_endpoint::process(program_id, accounts, ix_data),
        4 => instructions::update_endpoint_config::process(program_id, accounts, ix_data),
        5 => instructions::update_fee_recipients::process(program_id, accounts, ix_data),
        6 => instructions::pause_endpoint::process(program_id, accounts, ix_data),
        7 => instructions::top_up_coverage_pool::process(program_id, accounts, ix_data),
        8 => instructions::settle_batch::process(program_id, accounts, ix_data),
        // NOTE: agent custody is via SPL Token Approve (§3.1.2). No
        // initialize_agent_wallet / deposit_usdc / request_withdrawal /
        // execute_withdrawal / claim_refund instructions exist in this program;
        // refunds land directly in the agent's USDC ATA inside settle_batch.
        _ => Err(pinocchio::program_error::ProgramError::InvalidInstructionData),
    }
}
```

- [ ] **Step 6:** Create empty stubs to make it compile:

```bash
mkdir -p packages/program/programs-pinocchio/pact-market-pinocchio/src/instructions
for f in initialize_settlement_authority initialize_treasury initialize_protocol_config \
         register_endpoint update_endpoint_config update_fee_recipients pause_endpoint \
         top_up_coverage_pool settle_batch; do
  cat > packages/program/programs-pinocchio/pact-market-pinocchio/src/instructions/$f.rs <<EOF
use pinocchio::{account_info::AccountInfo, ProgramResult};

pub fn process(
    _program_id: &pinocchio::pubkey::Pubkey,
    _accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    Err(pinocchio::program_error::ProgramError::InvalidInstructionData)
}
EOF
done
```

- [ ] **Step 7:** Create `src/instructions/mod.rs` listing all 9 instructions:

```rust
pub mod initialize_protocol_config;
pub mod initialize_settlement_authority;
pub mod initialize_treasury;
pub mod pause_endpoint;
pub mod register_endpoint;          // creates per-endpoint CoveragePool atomically (§3.1.1)
pub mod settle_batch;
pub mod top_up_coverage_pool;       // scoped per slug (§3.1.1)
pub mod update_endpoint_config;
pub mod update_fee_recipients;
```

- [ ] **Step 8:** Create empty `state.rs`, `error.rs`, `pda.rs`, `discriminator.rs`, `constants.rs` with `// stub` comments.

- [ ] **Step 9:** Verify build:

```bash
cd packages/program && cargo build -p pact-market-pinocchio 2>&1 | tail -20
```

Expected: clean build (warnings about unused code OK).

- [ ] **Step 10:** Commit:

```bash
git add packages/program/
git commit -m "feat(pact-market): scaffold pact-market-pinocchio crate"
```

### Task 1A.1: Constants

**File:** `packages/program/programs-pinocchio/pact-market-pinocchio/src/constants.rs`

- [ ] **Step 1:** Write constants:

```rust
use pinocchio::pubkey::Pubkey;

// USDC mints
pub const USDC_MAINNET: Pubkey = solana_pubkey_macro::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDC_DEVNET: Pubkey = solana_pubkey_macro::pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// Batch
pub const MAX_BATCH_SIZE: usize = 50;

// Premium / fee caps (lamports of USDC, 6 decimals)
pub const MIN_PREMIUM_LAMPORTS: u64 = 100;          // $0.0001
pub const MAX_FEE_RECIPIENTS: usize = 8;            // §3.1.3
pub const MAX_TOTAL_FEE_BPS: u16 = 3_000;           // 30%, default protocol cap (§3.1.3)

// NOTE: WITHDRAWAL_COOLDOWN_SECS and MAX_DEPOSIT_LAMPORTS were removed from
// the V1 spec (§3.1.2) when agent custody moved to SPL Token approval. There
// is no deposit step and no withdrawal cooldown — agents always hold custody.
```

NOTE: `solana_pubkey_macro` is not standard in Pinocchio. If it's unavailable, use `Pubkey::from(<bytes>)` directly with the decoded base58. Alternative implementation:

```rust
use pinocchio::pubkey::Pubkey;
use five8_const::decode_32_const;

pub const USDC_MAINNET: Pubkey = decode_32_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDC_DEVNET: Pubkey = decode_32_const("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

pub const MAX_BATCH_SIZE: usize = 50;
pub const MIN_PREMIUM_LAMPORTS: u64 = 100;
pub const MAX_FEE_RECIPIENTS: usize = 8;
pub const MAX_TOTAL_FEE_BPS: u16 = 3_000;
```

Reference how the existing `pact-insurance-pinocchio` crate handles pubkey constants — use the same pattern.

- [ ] **Step 2:** Build: `cargo build -p pact-market-pinocchio`. Expected: clean.
- [ ] **Step 3:** Commit: `git add . && git commit -m "feat(pact-market): add constants module"`

### Task 1A.2: Errors

**File:** `packages/program/programs-pinocchio/pact-market-pinocchio/src/error.rs`

- [ ] **Step 1:** Write error enum per spec §3.1 (PRD codes 6000-6014 minus the deposit/withdrawal codes that are gone under §3.1.2, plus ArithmeticOverflow + the fee-validation codes from §3.1.3):

```rust
use pinocchio::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PactError {
    InsufficientBalance = 6000,
    EndpointPaused = 6001,
    ExposureCapExceeded = 6002,
    // 6003 (WithdrawalCooldownActive) and 6004 (NoPendingWithdrawal) intentionally
    // unused — withdrawal flow removed under §3.1.2 (agent custody via SPL approval).
    UnauthorizedSettler = 6005,
    UnauthorizedAuthority = 6006,
    DuplicateCallId = 6007,
    EndpointNotFound = 6008,
    // 6009 (DepositCapExceeded) intentionally unused — no deposit step under §3.1.2.
    PoolDepleted = 6010,
    InvalidTimestamp = 6011,
    BatchTooLarge = 6012,
    PremiumTooSmall = 6013,
    InvalidSlug = 6014,
    ArithmeticOverflow = 6015,
    // §3.1.3 fee-validation:
    FeeRecipientCountExceeded = 6016,
    FeeBpsExceedsCap = 6017,
    DuplicateFeeDestination = 6018,
    MultipleTreasuryRecipients = 6019,
    // §3.1.2 pre-flight delegate check:
    SettlementDelegateRevoked = 6020,
}

impl From<PactError> for ProgramError {
    fn from(e: PactError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
```

- [ ] **Step 2:** Build clean.
- [ ] **Step 3:** Commit: `feat(pact-market): add PactError enum`

### Task 1A.3: PDA helpers

**File:** `packages/program/programs-pinocchio/pact-market-pinocchio/src/pda.rs`

- [ ] **Step 1:** Write seed constants + derivation:

```rust
use pinocchio::pubkey::Pubkey;
use pinocchio::pubkey::find_program_address;

// CoveragePool is now per-endpoint (§3.1.1): seed = ["coverage_pool", slug].
pub const SEED_COVERAGE_POOL: &[u8] = b"coverage_pool";
pub const SEED_ENDPOINT: &[u8] = b"endpoint";
pub const SEED_CALL: &[u8] = b"call";
pub const SEED_SETTLEMENT_AUTHORITY: &[u8] = b"settlement_authority";
pub const SEED_TREASURY: &[u8] = b"treasury";                 // §3.1.3
pub const SEED_PROTOCOL_CONFIG: &[u8] = b"protocol_config";   // §3.1.3
// NOTE: SEED_AGENT_WALLET is intentionally absent — there is no AgentWallet
// PDA under §3.1.2; agent USDC stays in the agent's own ATA.

pub fn derive_coverage_pool(program_id: &Pubkey, slug: &[u8; 16]) -> (Pubkey, u8) {
    find_program_address(&[SEED_COVERAGE_POOL, slug], program_id)
}

pub fn derive_endpoint_config(program_id: &Pubkey, slug: &[u8; 16]) -> (Pubkey, u8) {
    find_program_address(&[SEED_ENDPOINT, slug], program_id)
}

pub fn derive_call_record(program_id: &Pubkey, call_id: &[u8; 16]) -> (Pubkey, u8) {
    find_program_address(&[SEED_CALL, call_id], program_id)
}

pub fn derive_settlement_authority(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[SEED_SETTLEMENT_AUTHORITY], program_id)
}

pub fn derive_treasury(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[SEED_TREASURY], program_id)
}

pub fn derive_protocol_config(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[SEED_PROTOCOL_CONFIG], program_id)
}
```

- [ ] **Step 2:** Build clean.
- [ ] **Step 3:** Commit: `feat(pact-market): add PDA derivation helpers`

### Task 1A.4: State accounts

**File:** `packages/program/programs-pinocchio/pact-market-pinocchio/src/state.rs`

Implement state structs per spec §3.1. Use `bytemuck::Pod + Zeroable` for zero-copy Pinocchio access. Reference the existing pact-insurance-pinocchio `state.rs` for the same pattern.

- [ ] **Step 1:** Write `CoveragePool` (per-endpoint, §3.1.1):

```rust
use bytemuck::{Pod, Zeroable};
use pinocchio::pubkey::Pubkey;

// One CoveragePool per endpoint slug (§3.1.1). Vault is the pool's USDC ATA.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CoveragePool {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub endpoint_slug: [u8; 16],
    pub total_deposits: u64,        // top-ups
    pub total_premiums: u64,        // gross premium-in (before fee fan-out)
    pub total_refunds: u64,         // refunds out to agents
    pub total_fees_paid: u64,       // §3.1.3 fees out to recipients
    pub current_balance: u64,       // residual = pool's share after fee fan-out
    pub created_at: i64,
}

impl CoveragePool {
    pub const LEN: usize = 1 + 7 + 32 + 32 + 32 + 16 + 8 + 8 + 8 + 8 + 8 + 8;
}
```

- [ ] **Step 2:** Write `EndpointConfig` (with `coverage_pool: Pubkey` + interchangeable `fee_recipients`, §3.1.1, §3.1.3):

```rust
// FeeRecipient is 48 bytes per spec §3.1.3.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct FeeRecipient {
    pub kind: u8,                 // FeeRecipientKind: Treasury | AffiliateAta | AffiliatePda
    pub destination: Pubkey,      // 32 bytes
    pub bps: u16,                 // share in basis points, off the premium
    pub _pad: [u8; 13],           // align to 48 bytes
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct EndpointConfig {
    pub bump: u8,
    pub paused: u8,
    pub fee_recipient_count: u8,        // §3.1.3, first N entries valid
    pub _padding0: [u8; 5],
    pub slug: [u8; 16],
    pub coverage_pool: Pubkey,          // §3.1.1 — resolves slug → pool
    pub flat_premium_lamports: u64,
    pub percent_bps: u16,
    pub _padding1: [u8; 6],
    pub sla_latency_ms: u32,
    pub _padding2: [u8; 4],
    pub imputed_cost_lamports: u64,
    pub exposure_cap_per_hour_lamports: u64,
    pub current_period_start: i64,
    pub current_period_refunds: u64,
    pub total_calls: u64,
    pub total_breaches: u64,
    pub total_premiums: u64,
    pub total_refunds: u64,
    pub last_updated: i64,
    pub fee_recipients: [FeeRecipient; 8],   // 8 × 48 = 384 bytes (§3.1.3)
}

impl EndpointConfig {
    pub const LEN: usize = 1+1+1+5+16+32+8+2+6+4+4+8+8+8+8+8+8+8+8+8+(8*48);
}
```

- [ ] **Step 3:** No `AgentWallet` struct — agent custody is via SPL Token approval (§3.1.2). The agent's USDC stays in their own ATA; per-agent stats are aggregated off-chain by the indexer from `CallRecord` rows. Skip this step.

- [ ] **Step 4:** Write `CallRecord` (note `agent_pubkey` not `agent_wallet`, plus `settlement_status` for the §3.1.2 pre-flight delegate check):

```rust
#[repr(u8)]
pub enum SettlementStatus {
    Settled = 0,
    DelegateFailed = 1,   // §3.1.2 pre-flight check skipped the CPI
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CallRecord {
    pub bump: u8,
    pub breach: u8,
    pub settlement_status: u8,        // SettlementStatus, §3.1.2
    pub _padding0: [u8; 5],
    pub call_id: [u8; 16],
    pub agent_pubkey: Pubkey,         // agent's wallet pubkey (NOT a PDA — §3.1.2)
    pub endpoint_slug: [u8; 16],
    pub premium_lamports: u64,
    pub refund_lamports: u64,
    pub latency_ms: u32,
    pub _padding1: [u8; 4],
    pub timestamp: i64,
}

impl CallRecord {
    pub const LEN: usize = 1+1+1+5+16+32+16+8+8+4+4+8;
}
```

- [ ] **Step 5:** Write `SettlementAuthority`:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct SettlementAuthority {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub signer: Pubkey,
    pub set_at: i64,
}

impl SettlementAuthority {
    pub const LEN: usize = 1+7+32+8;
}
```

- [ ] **Step 6:** Write `Treasury` and `ProtocolConfig` (§3.1.3):

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Treasury {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Pubkey,        // pool authority V1; multisig at mainnet flip
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,       // protocol fee vault
    pub created_at: i64,
}

impl Treasury {
    pub const LEN: usize = 1+7+32+32+32+8;
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ProtocolConfig {
    pub bump: u8,
    pub default_fee_recipient_count: u8,
    pub _padding0: [u8; 4],
    pub max_total_fee_bps: u16,                          // default 3000 (30%)
    pub default_fee_recipients: [FeeRecipient; 8],       // 8 × 48 = 384 bytes
}

impl ProtocolConfig {
    pub const LEN: usize = 1+1+4+2+(8*48);
}
```

- [ ] **Step 7:** Build: `cargo build -p pact-market-pinocchio`. Expected: clean.
- [ ] **Step 8:** Commit: `feat(pact-market): add state account layouts (per-endpoint pool + Treasury + ProtocolConfig + fee_recipients; no AgentWallet)`

### Task 1A.5: TS test infrastructure (LiteSVM)

**Files:** Create `packages/program/programs-pinocchio/pact-market-pinocchio/tests/{tsconfig.json,helpers.ts}`

- [ ] **Step 1:** Mirror existing pact-insurance-pinocchio test setup. Read `packages/program/programs-pinocchio/pact-insurance-pinocchio/tests/helpers.ts` for the LiteSVM pattern; copy its keypair-generation, USDC mint setup, transaction-builder helpers and adapt the program ID + struct decoders.

- [ ] **Step 2:** Add a `tests/_program.ts` that exposes:
  - `loadProgram(svm: LiteSVM): void` — loads compiled `pact_market.so`
  - `PROGRAM_ID: Address`
  - State decoders for each account using bytemuck-compatible byte slicing

- [ ] **Step 3:** Add `package.json` script (in the crate dir):

```json
{
  "scripts": {
    "test": "bun test",
    "build": "cargo build-sbf"
  }
}
```

- [ ] **Step 4:** Smoke test: run `cargo build-sbf -p pact-market-pinocchio` — must produce `target/sbf-solana-solana/release/pact_market.so`.
- [ ] **Step 5:** Commit: `chore(pact-market): test infrastructure`

### Task 1A.6: `initialize_coverage_pool` is REMOVED — folded into `register_endpoint` (§3.1.1)

There is no standalone `initialize_coverage_pool` instruction in V1. Per §3.1.1, registering an endpoint creates its per-endpoint `CoveragePool` PDA + USDC vault atomically inside `register_endpoint`. Endpoints can no longer exist in a registered-but-unfunded state. The pool tests that used to live in `tests/01-pool.ts` (PDA derived correctly, vault owned by pool PDA, duplicate rejected) are folded into Task 1A.8's `register_endpoint` test suite, plus a new test that verifies isolation across slugs (helius and birdeye registered get distinct CoveragePool PDAs and vaults).

Skip this task. Proceed to 1A.7.

### Task 1A.7: `initialize_settlement_authority` (TDD)

**Files:**
- Test: append to `tests/01-pool.ts`
- Impl: `src/instructions/initialize_settlement_authority.rs`

- [ ] **Step 1:** Write happy + negative tests:
  - Happy: pool authority signs, creates SettlementAuthority PDA with given signer pubkey
  - Negative: non-pool-authority can't initialize

- [ ] **Step 2:** Run tests to verify they fail.

- [ ] **Step 3:** Implement instruction. Pattern matches initialize_coverage_pool but:
  - Reads `signer: Pubkey` from instruction data (32 bytes)
  - Verifies caller signature matches `coverage_pool.authority`
  - Allocates `SettlementAuthority::LEN` account
  - Writes `signer`, `set_at`, `bump`

- [ ] **Step 4:** Run tests, expect PASS.
- [ ] **Step 5:** Commit: `feat(pact-market): initialize_settlement_authority`

### Task 1A.8: `register_endpoint` (TDD) — atomic endpoint + per-endpoint pool + fee_recipients

**Files:**
- Test: `tests/02-endpoint.ts` (also covers per-endpoint pool isolation; replaces the old `01-pool.ts`)
- Impl: `src/instructions/register_endpoint.rs`

Per §3.1.1, this instruction now atomically creates: (a) the `EndpointConfig` PDA, (b) the per-endpoint `CoveragePool` PDA seeded `["coverage_pool", slug]`, (c) the pool's USDC vault token account owned by the pool PDA. It also stamps `EndpointConfig.coverage_pool` so settler/clients can resolve the pool by slug. Per §3.1.3, it accepts an optional `fee_recipients` array (else falls back to `ProtocolConfig.default_fee_recipients`) and enforces all §3.1.3 validation invariants.

- [ ] **Step 1:** Write tests:
  - Happy: pool authority registers "helius" with default `fee_recipients` (omitted in ix data → falls back to `ProtocolConfig.default_fee_recipients`); both EndpointConfig and per-endpoint CoveragePool + vault initialized; `EndpointConfig.coverage_pool` matches the derived PDA
  - Happy: register "birdeye" with explicit `[Treasury 10%, AffiliateAta 5%]` override; EndpointConfig.fee_recipient_count=2, sum_bps=1500
  - Per-endpoint pool isolation: helius and birdeye end up with distinct CoveragePool PDAs and distinct vaults
  - Negative: non-pool-authority rejected with `UnauthorizedAuthority`
  - Negative: invalid slug (non-ASCII) rejected with `InvalidSlug`
  - Negative: register same slug twice rejected (account already in use)
  - Negative (§3.1.3): `fee_recipient_count > MAX_FEE_RECIPIENTS` → `FeeRecipientCountExceeded`
  - Negative: `sum(fee.bps) > MAX_TOTAL_FEE_BPS` → `FeeBpsExceedsCap`
  - Negative: two recipients with same `destination` → `DuplicateFeeDestination`
  - Negative: two recipients with kind=Treasury → `MultipleTreasuryRecipients`
  - Negative: `AffiliateAta` recipient whose ATA mint != USDC mint → rejected at registration time

- [ ] **Step 2:** Run, expect FAIL.

- [ ] **Step 3:** Implement instruction. Data layout (parse with byteslice):
  - bytes 0-15: `slug: [u8; 16]`
  - bytes 16-23: `flat_premium_lamports: u64`
  - bytes 24-25: `percent_bps: u16`
  - bytes 26-29: `sla_latency_ms: u32`
  - bytes 30-37: `imputed_cost_lamports: u64`
  - bytes 38-45: `exposure_cap_per_hour_lamports: u64`
  - byte 46: `fee_recipients_present: u8` (0 = use ProtocolConfig defaults; 1 = explicit array follows)
  - if present: byte 47: `fee_recipient_count: u8` (0..=8); then `fee_recipient_count` × 48 bytes of `FeeRecipient`

  Total: 47 bytes (defaults) or 48 + 48*N bytes (explicit).

  Validate slug: every byte must be ASCII printable or 0 (null pad). If any byte > 127, return `InvalidSlug`.

  After parsing, allocate (a) EndpointConfig PDA and (b) CoveragePool PDA + vault atomically (CreateAccount + InitializeAccount3 CPIs). Stamp `EndpointConfig.coverage_pool = derive_coverage_pool(program_id, slug).0`. Apply §3.1.3 validation invariants before writing fee_recipients.

- [ ] **Step 4:** Run tests, expect PASS.
- [ ] **Step 5:** Commit: `feat(pact-market): register_endpoint (atomic per-endpoint pool + fee_recipients)`

### Task 1A.9: `update_endpoint_config` (TDD)

**Files:**
- Test: append to `tests/02-endpoint.ts`
- Impl: `src/instructions/update_endpoint_config.rs`

Data layout (Optional fields, 1 byte presence flag + value):
```
[present:u8][value: bytes per type] x 5 fields
present == 0 → skip; present == 1 → read value
```

- [ ] **Step 1:** Tests:
  - Happy: update flat_premium only, others unchanged
  - Happy: update all 5 fields
  - Negative: non-authority rejected

- [ ] **Step 2-5:** TDD cycle, commit: `feat(pact-market): update_endpoint_config`

### Task 1A.10: `pause_endpoint` (TDD)

**Files:**
- Test: `tests/06-pause.ts`
- Impl: `src/instructions/pause_endpoint.rs`

- [ ] **Step 1:** Tests: pool authority can pause/unpause; non-authority rejected.
- [ ] **Step 2-5:** TDD cycle. Commit: `feat(pact-market): pause_endpoint`

### Task 1A.11: `initialize_treasury` (TDD) — §3.1.3

**Files:**
- Test: `tests/01-treasury-protocol-config.ts`
- Impl: `src/instructions/initialize_treasury.rs`

Singleton bootstrap for the protocol fee vault (§3.1.3). PDA seed = `["treasury"]`. Authority = pool authority V1; will rotate to multisig at mainnet flip per §11 risk register.

- [ ] **Step 1:** Tests:
  - Happy: pool authority signs; creates Treasury PDA + USDC vault token account; vault owner is the Treasury PDA
  - Negative: non-pool-authority rejected with `UnauthorizedAuthority`
  - Idempotency: re-initialize rejected (account already in use)

- [ ] **Step 2-5:** TDD. Pattern matches the old initialize_coverage_pool (one PDA + one vault). Commit: `feat(pact-market): initialize_treasury`

### Task 1A.12: `initialize_protocol_config` (TDD) — §3.1.3

**Files:**
- Test: append to `tests/01-treasury-protocol-config.ts`
- Impl: `src/instructions/initialize_protocol_config.rs`

Singleton. Stores `max_total_fee_bps` and the default fee-recipient template used when `register_endpoint` doesn't supply explicit `fee_recipients`.

- [ ] **Step 1:** Tests:
  - Happy: pool authority initializes ProtocolConfig with `max_total_fee_bps=3000`, defaults `[Treasury 10%, AffiliateAta(market_treasury) 5%]`
  - Validation: same §3.1.3 invariants (count ≤ 8, sum_bps ≤ max, no duplicate destinations, ≤ 1 Treasury, AffiliateAta has correct mint)
  - Negative: non-pool-authority rejected
  - Idempotency: re-initialize rejected

- [ ] **Step 2-5:** TDD. Commit: `feat(pact-market): initialize_protocol_config`

### Task 1A.13: `update_fee_recipients` (TDD) — §3.1.3

**Files:**
- Test: `tests/04-fee-fanout.ts` (will also cover the §3.1.3 fan-out math in 1A.16)
- Impl: `src/instructions/update_fee_recipients.rs`

Atomic replace of an endpoint's `fee_recipients` array. Same invariants enforced as `register_endpoint`.

- [ ] **Step 1:** Tests:
  - Happy: pool authority swaps "helius" recipients from `[Treasury 10%, Affiliate 5%]` to `[Treasury 8%]`; subsequent `settle_batch` only pays Treasury 8%, pool retains 92%
  - Negative: non-pool-authority rejected
  - Validation: all §3.1.3 invariants enforced (sum_bps ≤ MAX_TOTAL_FEE_BPS, no duplicates, ≤ 1 Treasury, AffiliateAta with correct mint)

- [ ] **Step 2-5:** TDD. Commit: `feat(pact-market): update_fee_recipients`

### Task 1A.14: SPL Token approval setup (test infrastructure — no on-chain instruction)

There is **no on-chain instruction** for agent custody under §3.1.2. The agent grants spending allowance to the `SettlementAuthority` PDA via the standard SPL Token `Approve` instruction (a vanilla SPL Token call, no protocol-side ix). All previously planned `initialize_agent_wallet` / `deposit_usdc` / `request_withdrawal` / `execute_withdrawal` instructions are **removed from the program** per §3.1.2.

What this task delivers is *test-side helpers* that exercise the SPL approval flow against the program's `settle_batch` (Task 1A.16):

**Files:** append helpers to `tests/helpers.ts`; new test file `tests/03-approval.ts`.

- [ ] **Step 1:** Helper `splApprove({ owner, ata, delegate, amount })` that emits a vanilla SPL Token `Approve` ix. `splRevoke({ owner, ata })` likewise.
- [ ] **Step 2:** Helper `assertDelegate({ ata, delegate, delegated_amount })` that decodes a `spl-token` Account and asserts `state == Initialized`, `delegate == Some(delegate)`, `delegated_amount >= expected`.
- [ ] **Step 3:** Test `tests/03-approval.ts`:
  - Happy approval: owner ATAs hold 5 USDC; `splApprove(owner=agent, delegate=settlement_authority_pda, 5_000_000)` succeeds; `assertDelegate` passes
  - Revoke: after Approve, `splRevoke` clears delegate; subsequent `settle_batch` pre-flight delegate check stamps `SettlementStatus::DelegateFailed` (verified in 1A.16)
- [ ] **Step 4:** Commit: `test(pact-market): SPL approval helpers + happy-path assertions`

### Task 1A.15: `top_up_coverage_pool` (TDD) — per-endpoint (§3.1.1)

**Files:**
- Test: append to `tests/02-endpoint.ts`
- Impl: `src/instructions/top_up_coverage_pool.rs`

Now scoped to a specific endpoint's pool (§3.1.1) — accepts a slug and credits only that pool's vault.

- [ ] **Step 1:** Tests:
  - Happy: pool authority tops up "helius" pool by 100 USDC; helius `current_balance += 100`, helius `total_deposits += 100`; "birdeye" pool unaffected
  - Negative: non-authority rejected
  - Negative: top-up against an unregistered slug rejected with `EndpointNotFound`

- [ ] **Step 2-5:** TDD. Data layout: bytes 0-15 = slug, bytes 16-23 = amount: u64. CPI from authority ATA → endpoint's CoveragePool vault. Commit.

### Task 1A.16: `settle_batch` — the critical instruction (TDD)

**Files:**
- Test: `tests/05-settle-batch.ts`
- Impl: `src/instructions/settle_batch.rs`

This is the most complex instruction. It is THE critical path for refund correctness. Combines four spec changes: (a) per-endpoint pool resolution (§3.1.1), (b) SPL approval-based debit with pre-flight delegate check (§3.1.2), (c) channel-then-fan-out fee distribution (§3.1.3), (d) refund directly to agent's USDC ATA on breach.

**Data layout:**
- bytes 0-1: event_count: u16 (LE)
- repeating event_count times:
  - call_id: [u8; 16]
  - agent_pubkey: Pubkey (32) — agent's wallet pubkey, NOT a PDA
  - endpoint_slug: [u8; 16]
  - premium_lamports: u64
  - refund_lamports: u64
  - latency_ms: u32
  - breach: u8 (0|1)
  - timestamp: i64

Total per event: 16+32+16+8+8+4+1+7(pad)+8 = 100 bytes.
Total ix data: 2 + 100*event_count.

**Account list (channel-then-fan-out, §3.1.3):**
- 0: settlement_authority signer (signer)
- 1: settlement_authority PDA (read; also acts as SPL Token delegate per §3.1.2)
- 2: token_program (read)
- 3: clock sysvar (read)
- 4..: per unique endpoint slug in batch: [endpoint_config PDA (writable), coverage_pool PDA (writable), coverage_pool USDC vault (writable)]
- ..: per unique fee-recipient destination across batch (deduplicated): destination token account (writable)
- ..: per unique agent in batch: agent USDC ATA (writable; debit source AND refund destination)
- ..: per event: call_record PDA (writable, init-if-needed)

Settler groups events by endpoint slug, derives per-endpoint pool PDAs, deduplicates fee-recipient destinations and agent ATAs across the batch. Document the account-list contract in the instruction's header comment.

- [ ] **Step 1:** Test: single-event batch with no breach (Treasury 10% + Affiliate 5% template). After settle:
  - Premium debited from agent USDC ATA → endpoint's CoveragePool vault (via SPL delegate authority — settlement_authority signs as PDA delegate)
  - Treasury vault credited with `premium * 1000 / 10_000`
  - Affiliate ATA credited with `premium * 500 / 10_000`
  - CoveragePool vault retains the residual (85% of premium)
  - CallRecord created with `settlement_status = Settled`
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement. Skeleton:

```rust
// Pseudocode order (per event):
// 1. verify settler signer matches settlement_authority.signer
// 2. parse event_count, ensure <= MAX_BATCH_SIZE (else BatchTooLarge)
// 3. for each event:
//    a. resolve endpoint_config + coverage_pool by slug (verify EndpointConfig.coverage_pool matches derived PDA — §3.1.1)
//    b. validate timestamp <= clock.unix_timestamp (else InvalidTimestamp)
//    c. validate premium >= MIN_PREMIUM_LAMPORTS (else PremiumTooSmall)
//    d. validate endpoint not paused (else EndpointPaused)
//    e. check call_record account is uninitialized (else DuplicateCallId)
//    f. check exposure cap: if current_period_start + 3600 < now, reset period.
//       if current_period_refunds + refund > exposure_cap, set refund=0 (skip refund)
//    g. allocate CallRecord PDA via CreateAccount CPI; default settlement_status = Settled
//
//    --- §3.1.2 pre-flight delegate check (CRITICAL: read-only, BEFORE the CPI) ---
//    h. read agent_usdc_ata data; verify (1) state == Initialized,
//       (2) delegate == Some(settlement_authority_pda),
//       (3) delegated_amount >= premium.
//       If any check fails: stamp call_record.settlement_status = DelegateFailed,
//       SKIP the SPL Token CPI, continue to next event. (Other agents in the batch
//       are unaffected — no whole-tx revert.)
//    --- end pre-flight ---
//
//    i. SPL Token Transfer premium: agent_usdc_ata → coverage_pool.vault for `premium`
//       (signed by settlement_authority PDA acting as the SPL delegate, §3.1.2)
//    j. update endpoint.total_calls, total_premiums, current_period_refunds (if breach)
//    k. update coverage_pool.total_premiums (gross premium-in)
//
//    --- §3.1.3 channel-then-fan-out: pool is the source of every fee transfer ---
//    l. for each FeeRecipient in endpoint.fee_recipients[..fee_recipient_count]:
//          fee = premium * recipient.bps / 10_000  (rounded down — pool absorbs remainder)
//          SPL Token Transfer fee: coverage_pool.vault → recipient.destination
//          (signed by coverage_pool PDA seeds ["coverage_pool", slug])
//          update coverage_pool.total_fees_paid += fee
//    m. coverage_pool.current_balance is implicit = total_premiums + total_deposits
//          - total_refunds - total_fees_paid; the unallocated residual stays in the vault
//          by virtue of not being moved.
//    --- end fan-out ---
//
//    n. if breach && refund > 0:
//        check coverage_pool vault balance >= refund (else PoolDepleted, skip refund;
//        premium + fees still settled — pool depletion is scoped per pool, §6)
//        SPL Token Transfer refund: coverage_pool.vault → agent_usdc_ata
//        (signed by coverage_pool PDA; lands DIRECTLY in agent's wallet, no claim step — §3.1.2)
//        update coverage_pool.total_refunds, endpoint.total_breaches, total_refunds
```

- [ ] **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Add tests for:
  - Batch of 5 events with mixed breaches (3 success, 2 breach); refunds land directly in agents' USDC ATAs (no claim step)
  - Mixed-endpoint batch (helius + birdeye in one batch): each pool debited/credited correctly; per-endpoint pool isolation holds (§3.1.1)
  - Per-recipient fee fan-out: default `[Treasury 10%, Affiliate 5%]` template, no-affiliate template `[Treasury 10%]`, multi-affiliate template; Treasury vault and AffiliateAta both credited with correct shares; rounding remainder stays in the pool
  - Duplicate call_id in same batch (second errors with DuplicateCallId)
  - Re-submission of already-settled call_id (CallRecord init fails)
  - Unauthorized settler rejected with `UnauthorizedSettler`
  - Paused endpoint event errored with `EndpointPaused`
  - Pool depleted (per pool, §3.1.1): refund skipped silently for THAT pool only; other endpoints' pools in the same batch unaffected
  - Batch size MAX_BATCH_SIZE+1 rejected with `BatchTooLarge`
  - Future timestamp rejected with `InvalidTimestamp`
  - Premium below MIN rejected with `PremiumTooSmall`
  - **§3.1.2 pre-flight delegate check:** revoked approval → `settlement_status = DelegateFailed`, no CPI attempted, agent ATA untouched, OTHER events in same batch settle normally
  - **§3.1.2 pre-flight delegate check:** insufficient `delegated_amount` → `settlement_status = DelegateFailed` (same behaviour as revoked)

- [ ] **Step 6:** Run all settle_batch tests, all pass.
- [ ] **Step 7:** Commit: `feat(pact-market): settle_batch (per-endpoint pool + SPL delegate debit + pre-flight check + channel-then-fan-out fees + direct refund)`

### Task 1A.17: `claim_refund` is REMOVED (§3.1.2)

There is no `claim_refund` instruction in V1. Per §3.1.2, refunds land directly in the agent's USDC ATA inside `settle_batch` itself (covered in Task 1A.16 step 5). No claim step, no `total_refunds_claimed` field, no `RefundClaimer` hook. Skip this task. Proceed to 1A.18.

### Task 1A.18: Exposure cap test

**File:** `tests/07-exposure-cap.ts`

- [ ] **Step 1:** Test: register endpoint with `exposure_cap_per_hour = 1_000_000` (1 USDC). Submit 3 settle_batches in quick succession with breach refunds totaling 1.5 USDC. Verify the third batch's refund is set to 0 (capped) but premium still debited.

- [ ] **Step 2:** Test: 2 hours later (advance clock), period resets, full refund allowed again.

- [ ] **Step 3:** Run, both pass. Commit: `test(pact-market): exposure cap enforcement`

### Task 1A.19: Build & verify SBF binary

- [ ] **Step 1:** From repo root: `pnpm --filter @pact-network/pact-market-pinocchio build` (assuming we wired the package.json) OR `cd packages/program && cargo build-sbf -p pact-market-pinocchio`.
- [ ] **Step 2:** Verify the .so file exists: `ls -la packages/program/target/sbf-solana-solana/release/pact_market.so`
- [ ] **Step 3:** Run all tests: `bun test` from the crate dir. All pass.
- [ ] **Step 4:** Commit if any final fixups: `chore(pact-market): final build verification`

### Task 1A.20: Deploy to devnet, capture program ID

- [ ] **Step 1:** Ensure local solana CLI on devnet: `solana config set --url https://api.devnet.solana.com`
- [ ] **Step 2:** Generate program keypair: `solana-keygen new --no-bip39-passphrase --silent --outfile /tmp/pact-market-program-devnet.json`
- [ ] **Step 3:** Get pubkey: `PROGRAM_ID=$(solana address -k /tmp/pact-market-program-devnet.json)` and record.
- [ ] **Step 4:** Fund deployer wallet with 1 SOL: `solana airdrop 2`
- [ ] **Step 5:** Deploy:

```bash
solana program deploy \
  --program-id /tmp/pact-market-program-devnet.json \
  packages/program/target/sbf-solana-solana/release/pact_market.so
```

Expected output: "Program Id: <PROGRAM_ID>".

- [ ] **Step 6:** Verify: `solana program show $PROGRAM_ID` — confirm size, authority, executable.
- [ ] **Step 7:** Move keypair to 1Password (vault `pact-market-devnet-keys` as `pact-market-program-keypair`), then shred local: `shred -u /tmp/pact-market-program-devnet.json`.
- [ ] **Step 8:** Add program ID to `packages/shared/src/version.ts`:

```ts
export const PROGRAM_ID_DEVNET = "<PROGRAM_ID>";
export const PROGRAM_ID_MAINNET = "TBD";
```

- [ ] **Step 9:** Commit: `chore(pact-market): set devnet program ID`
- [ ] **Step 10:** Push branch: `git push -u origin feat/pact-market-program`
- [ ] **Step 11:** Open PR against `develop` titled `feat(pact-market): pact-market-pinocchio crate + devnet deploy`. Body summarizes 12 instructions, 8 test files, deploy SHA.

### Task 1A.21: Generate Codama TS client

**File:** `packages/shared/src/codama-pact-market.ts` (auto-generated)

- [ ] **Step 1:** Generate IDL via Codama from the Rust crate. If we don't already have a generator script, mirror the one in `packages/insurance/`. Run:

```bash
pnpm --filter @pact-network/shared codama:generate-pact-market
```

- [ ] **Step 2:** Verify generated client exports the 9 instructions: `getInitializeSettlementAuthorityInstruction`, `getInitializeTreasuryInstruction`, `getInitializeProtocolConfigInstruction`, `getRegisterEndpointInstruction`, `getUpdateEndpointConfigInstruction`, `getUpdateFeeRecipientsInstruction`, `getPauseEndpointInstruction`, `getTopUpCoveragePoolInstruction`, `getSettleBatchInstruction`. NO `getInitializeCoveragePoolInstruction`, `getInitializeAgentWalletInstruction`, `getDepositUsdcInstruction`, `getRequestWithdrawalInstruction`, `getExecuteWithdrawalInstruction`, `getClaimRefundInstruction` — those are not part of V1 (§3.1.1, §3.1.2).
- [ ] **Step 3:** Commit: `chore(pact-market): generate Codama TS client`

---

## Wave 1B — `pact-proxy` (Hono on Cloud Run) [Market interface]

> **Layering note:** This package will be renamed `@pact-network/proxy` → `@pact-network/market-proxy` in Step B of the layering refactor (see `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md`). It will consume a new `@pact-network/wrap` Network-rails library that holds the generic agent-side wrapping primitives, so this proxy keeps only the market-specific surface (registry, pricing, billing UX).

**Branch:** `feat/pact-market-proxy`
**Owner:** Crew agent `proxy-crew`
**Depends on:** Wave 0 (Pub/Sub topic + service account); also reads `endpoints` table from Postgres so depends on indexer's migration applying first OR seeds itself.

### File structure

```
packages/proxy/
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   ├── index.ts              # Hono app
│   ├── routes/
│   │   ├── proxy.ts
│   │   ├── health.ts
│   │   ├── agents.ts
│   │   └── admin.ts
│   ├── lib/
│   │   ├── endpoints.ts      # registry loader + cache
│   │   ├── balance.ts        # RPC agent USDC ATA + SPL delegated_amount read + LRU (§3.1.2)
│   │   ├── timing.ts
│   │   ├── events.ts         # Pub/Sub publish
│   │   ├── classifier.ts     # outcome computation
│   │   ├── force-breach.ts   # demo mode
│   │   └── allowlist.ts      # demo + operator allowlist loader
│   ├── endpoints/
│   │   ├── helius.ts
│   │   ├── birdeye.ts
│   │   ├── jupiter.ts
│   │   └── types.ts
│   └── env.ts
└── test/
    ├── proxy.test.ts
    ├── classifier.test.ts
    ├── balance.test.ts
    ├── force-breach.test.ts
    └── helpers.ts
```

### Task 1B.0: Branch + start

- [ ] **Step 1:** `git checkout develop && git pull && git checkout -b feat/pact-market-proxy`

The package was already scaffolded in PR #48. Verify `packages/proxy/` exists and `pnpm --filter @pact-network/proxy build` succeeds. If yes, proceed.

### Task 1B.1: Wire @hono/node-server + Cloud Run signal handling

**File:** `packages/proxy/src/index.ts`

The current scaffold uses Workers-style export. For Cloud Run we need a Node HTTP server. Adapt:

- [ ] **Step 1:** Add `@hono/node-server` dependency: `pnpm --filter @pact-network/proxy add @hono/node-server`
- [ ] **Step 2:** Update `src/index.ts`:

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { proxyRoute } from "./routes/proxy";
import { agentsRoute } from "./routes/agents";
import { adminRoute } from "./routes/admin";

const app = new Hono();
app.get("/health", healthRoute);
app.get("/v1/agents/:pubkey", agentsRoute);
app.all("/v1/:slug/*", proxyRoute);
app.post("/admin/reload-endpoints", adminRoute);

const port = parseInt(process.env.PORT ?? "8080", 10);
serve({ fetch: app.fetch, port });
console.log(`pact-proxy listening on :${port}`);
```

- [ ] **Step 3:** Update `package.json` start script: `"start": "node dist/index.js"`. Keep `"dev": "tsx watch src/index.ts"`.
- [ ] **Step 4:** Build clean, commit: `feat(proxy): switch to @hono/node-server for Cloud Run`

### Task 1B.2: env validation

**File:** `packages/proxy/src/env.ts`

- [ ] **Step 1:** Use zod for env parsing:

```ts
import { z } from "zod";

const Env = z.object({
  PG_URL: z.string().url(),
  RPC_URL: z.string().url(),
  PROGRAM_ID: z.string().min(32),
  PUBSUB_PROJECT: z.string(),
  PUBSUB_TOPIC: z.string(),
  ENDPOINTS_RELOAD_TOKEN: z.string().min(16),
  PORT: z.string().default("8080"),
});

export const env = Env.parse(process.env);
```

- [ ] **Step 2:** Add `pnpm --filter @pact-network/proxy add zod pg @google-cloud/pubsub @solana/kit`
- [ ] **Step 3:** Commit: `feat(proxy): env schema`

### Task 1B.3: Endpoint registry loader (TDD)

**File:** `packages/proxy/src/lib/endpoints.ts`, `test/endpoints.test.ts`

- [ ] **Step 1:** Test:

```ts
import { test, expect, vi } from "vitest";
import { EndpointRegistry } from "../src/lib/endpoints";

test("loads endpoints from Postgres on first call, caches 60s", async () => {
  const mockPg = { query: vi.fn().mockResolvedValue({ rows: [
    { slug: "helius", flat_premium_lamports: "500", paused: false, sla_latency_ms: 1200, /* ... */ }
  ]}) };
  const reg = new EndpointRegistry(mockPg as any);
  const e1 = await reg.get("helius");
  expect(e1?.slug).toBe("helius");
  expect(mockPg.query).toHaveBeenCalledTimes(1);
  await reg.get("helius"); // cache hit
  expect(mockPg.query).toHaveBeenCalledTimes(1);
});

test("reload() forces refresh", async () => {
  const mockPg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  const reg = new EndpointRegistry(mockPg as any);
  await reg.get("helius");
  await reg.reload();
  await reg.get("helius");
  expect(mockPg.query).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2:** Run, FAIL.
- [ ] **Step 3:** Implement:

```ts
import { Pool } from "pg";

export interface EndpointRow {
  slug: string;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
  paused: boolean;
  upstreamBase: string;
  displayName: string;
}

export class EndpointRegistry {
  private cache = new Map<string, EndpointRow>();
  private loadedAt = 0;
  private readonly TTL_MS = 60_000;

  constructor(private readonly pg: Pool) {}

  async get(slug: string): Promise<EndpointRow | undefined> {
    if (Date.now() - this.loadedAt > this.TTL_MS) {
      await this.reload();
    }
    return this.cache.get(slug);
  }

  async reload(): Promise<void> {
    const { rows } = await this.pg.query(
      `SELECT slug, flat_premium_lamports, percent_bps, sla_latency_ms,
              imputed_cost_lamports, exposure_cap_per_hour_lamports,
              paused, upstream_base, display_name FROM endpoints`
    );
    this.cache.clear();
    for (const r of rows) {
      this.cache.set(r.slug, {
        slug: r.slug,
        flatPremiumLamports: BigInt(r.flat_premium_lamports),
        percentBps: r.percent_bps,
        slaLatencyMs: r.sla_latency_ms,
        imputedCostLamports: BigInt(r.imputed_cost_lamports),
        exposureCapPerHourLamports: BigInt(r.exposure_cap_per_hour_lamports),
        paused: r.paused,
        upstreamBase: r.upstream_base,
        displayName: r.display_name,
      });
    }
    this.loadedAt = Date.now();
  }
}
```

- [ ] **Step 4:** Run, PASS.
- [ ] **Step 5:** Commit: `feat(proxy): endpoint registry with 60s cache`

### Task 1B.4: Allowlist loader (TDD)

**File:** `packages/proxy/src/lib/allowlist.ts`, `test/allowlist.test.ts`

Same shape as registry: load `demo_allowlist` and `operator_allowlist` tables on cold start, cache with TTL.

- [ ] **Step 1-5:** TDD per pattern. Commit: `feat(proxy): allowlist loaders`

### Task 1B.5: Balance cache (TDD) — agent USDC ATA + SPL delegated_amount (§3.1.2)

**File:** `packages/proxy/src/lib/balance.ts`

Under the §3.1.2 model there is no `AgentWallet` PDA. The proxy reads the agent's regular USDC ATA balance plus the SPL Token `delegated_amount` (allowance remaining for the SettlementAuthority delegate). The eligible amount for premium-gating is `min(ataBalance, delegated_amount)`.

- [ ] **Step 1:** Test with mocked RPC:
  - Returns cached `{ ataBalance, allowance, eligible }` value within TTL
  - On expiry, re-fetches via `getAccountInfo` against the agent's USDC ATA (derived from the agent pubkey + USDC mint via `getAssociatedTokenAddress`); decodes the `spl-token` Account layout — `amount: u64` (offset 64) and `delegated_amount: u64` (offset 121) — plus verifies `state == Initialized` and `delegate == Some(settlement_authority_pda)`
  - When `delegate` is None or differs → `allowance = 0n`, `eligible = 0n` (banner-prompts agent to re-approve, see §3.1.2)
  - On RPC error, returns `{ ataBalance: 0n, allowance: 0n, eligible: 0n }` and logs (don't throw — agent shouldn't be blocked)

- [ ] **Step 2-5:** Implement, run, commit.

### Task 1B.6: High-precision Timer (TDD)

**File:** `packages/proxy/src/lib/timing.ts`

- [ ] **Step 1:** Test: `Timer` records `t_start` on construct, `markFirstByte()` records `t_first_byte`, `latencyMs()` returns the difference.
- [ ] **Step 2-5:** Trivial impl, commit.

### Task 1B.7: Pub/Sub event publisher (TDD)

**File:** `packages/proxy/src/lib/events.ts`

- [ ] **Step 1:** Test with mocked `@google-cloud/pubsub`:
  - `publishEvent(event)` calls `topic.publishMessage({ json: event })`
  - On error, logs but doesn't throw

- [ ] **Step 2-5:** Implement using `PubSub` client. Initialize once with `PUBSUB_PROJECT`, get topic from env. Commit.

### Task 1B.8: Force-breach gate (TDD)

**File:** `packages/proxy/src/lib/force-breach.ts`

- [ ] **Step 1:** Tests:
  - `query.demo_breach !== "1"` → `applyDemoBreach()` is no-op
  - `demo_breach=1` AND wallet IN allowlist → sleeps `endpoint.sla_latency_ms + 300`
  - `demo_breach=1` but wallet NOT in allowlist → no sleep

- [ ] **Step 2-5:** Implement. Commit.

### Task 1B.9: Endpoint handlers — Helius (TDD)

**File:** `packages/proxy/src/endpoints/helius.ts`, `test/endpoints/helius.test.ts`

Helius is RPC-style: JSON-RPC 2.0 POST. Spec PRD §7.1.

Each handler implements:

```ts
export interface EndpointHandler {
  upstreamBase: string;
  buildRequest(req: Request, params: { slug: string }): Promise<Request>;
  classify(resp: Response, latencyMs: number, endpoint: EndpointRow):
    Promise<{ premium: bigint; refund: bigint; breach: boolean; reason?: "latency"|"5xx" }>;
  isInsurableMethod(req: Request): Promise<boolean>;
}
```

- [ ] **Step 1:** Tests:
  - `isInsurableMethod`: parses JSON body, returns true if method in `[getAccountInfo, sendTransaction, getTransaction, getBalance, getSignatureStatuses, getProgramAccounts]`
  - `classify`: 200 + latency<=sla → `{premium: flat, refund: 0, breach: false}`
  - `classify`: 200 + latency>sla → `{premium: flat, refund: imputed_cost, breach: true, reason: "latency"}`
  - `classify`: 5xx → `{premium: flat, refund: imputed_cost, breach: true, reason: "5xx"}`
  - `classify`: 429 → `{premium: 0, refund: 0, breach: false}` (rate limit, no premium)
  - `classify`: 200 with JSON-RPC error code -32603 → upstream_failure (refund); -32602 → user error (no premium)

- [ ] **Step 2-5:** Implement, commit.

### Task 1B.10: Endpoint handlers — Birdeye + Jupiter (TDD)

**Files:** `packages/proxy/src/endpoints/{birdeye,jupiter}.ts`

- [ ] **Step 1-5:** Per PRD §7.2 + §7.3. REST GET endpoints. Different pattern — header auth (`X-API-KEY`) for Birdeye, no auth for Jupiter. classify simpler: status code mapping per PRD. Commit each.

### Task 1B.11: Proxy route (TDD)

**File:** `packages/proxy/src/routes/proxy.ts`, `test/proxy.test.ts`

Wire all the libs together. Order:

1. extract slug from path
2. registry.get(slug) → endpoint or 404
3. parse `?pact_wallet=<pubkey>` → if absent, just forward (uninsured passthrough)
4. registry endpoint paused → return 503 paused
5. balance.get(wallet) — returns `{ ataBalance, allowance, eligible }` per §3.1.2; if `eligible < flat_premium` → 402 (covers both insufficient USDC and insufficient/missing SPL approval)
6. handler = endpoints[slug]; isInsurable = await handler.isInsurableMethod(req); if false, forward without premium
7. timer = new Timer
8. force-breach: applyDemoBreach if demo_breach=1 + wallet allowlisted
9. forward upstream (handler.buildRequest + fetch)
10. timer.markFirstByte
11. classify → outcome
12. publish event to Pub/Sub (fire-and-forget)
13. set X-Pact-* headers, return upstream body

- [ ] **Step 1-3:** Test happy path (helius, normal latency), breach path (force-breach), 402 path (insufficient balance), passthrough path (no pact_wallet). Each test mocks dependencies.
- [ ] **Step 4-5:** Implement, run, commit.

### Task 1B.12: Health + admin routes

**Files:** `packages/proxy/src/routes/{health,admin,agents}.ts`

- `health`: `{ status: "ok", version: "v1", endpoints_loaded: registry.size, cache_size: balance.size }`
- `admin/reload-endpoints`: bearer token check vs `ENDPOINTS_RELOAD_TOKEN`, then `registry.reload()` + `allowlist.reload()`
- `agents/:pubkey`: read agent's USDC ATA balance + SPL `delegated_amount` (allowance) via RPC; return JSON snapshot `{ ataBalance, allowance, eligible }` (§3.1.2 — no AgentWallet PDA exists)

- [ ] **Step 1-5:** TDD each. Commit.

### Task 1B.13: Dockerfile

**File:** `packages/proxy/Dockerfile`

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/proxy/package.json packages/proxy/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @pact-network/proxy --filter @pact-network/shared --filter @pact-network/db
COPY tsconfig.base.json ./
COPY packages/proxy packages/proxy
COPY packages/shared packages/shared
COPY packages/db packages/db
RUN pnpm --filter @pact-network/proxy build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
WORKDIR /app/packages/proxy
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 1:** Test build locally: `docker build -f packages/proxy/Dockerfile -t pact-proxy .` from repo root. Build clean.
- [ ] **Step 2:** Test run: `docker run -p 8080:8080 -e PG_URL=... -e RPC_URL=... pact-proxy`. Health endpoint responds.
- [ ] **Step 3:** Commit: `feat(proxy): Dockerfile for Cloud Run`

### Task 1B.14: Cloud Run deploy script

**File:** `scripts/deploy-proxy.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
source deploy/gcp.env

IMAGE="$ARTIFACT_REGISTRY/proxy:$(git rev-parse --short HEAD)"

docker build --platform=linux/amd64 -f packages/proxy/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"

gcloud run deploy pact-proxy \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --platform=managed \
  --service-account="pact-proxy@$GCP_PROJECT.iam.gserviceaccount.com" \
  --add-cloudsql-instances="$CLOUDSQL_INSTANCE" \
  --set-env-vars="PG_URL=$PG_URL,RPC_URL=$RPC_URL,PROGRAM_ID=$PROGRAM_ID,PUBSUB_PROJECT=$GCP_PROJECT,PUBSUB_TOPIC=pact-settle-events" \
  --set-secrets="ENDPOINTS_RELOAD_TOKEN=pact-endpoints-reload-token:latest" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=10 \
  --memory=512Mi
```

- [ ] **Step 1:** First create the `ENDPOINTS_RELOAD_TOKEN` secret: `openssl rand -hex 32 | gcloud secrets create pact-endpoints-reload-token --data-file=-`
- [ ] **Step 2:** Make script executable: `chmod +x scripts/deploy-proxy.sh`
- [ ] **Step 3:** Run deploy, capture URL: `bash scripts/deploy-proxy.sh`. Note `pact-proxy-<hash>.run.app`.
- [ ] **Step 4:** Smoke test: `curl https://pact-proxy-<hash>.run.app/health` — expect 200.
- [ ] **Step 5:** Commit script: `feat(deploy): proxy Cloud Run deploy script`
- [ ] **Step 6:** Push branch, open PR.

---

## Wave 1C — `pact-settler` (NestJS on Cloud Run) [Network rails]

**Branch:** `feat/pact-market-settler`
**Owner:** Crew agent `settler-crew`
**Depends on:** Wave 0 (Pub/Sub subscription, Secret Manager); Wave 1A Codama client (only at integration); Wave 1D indexer URL (only at integration).

### Task 1C.0: Branch + module structure

- [ ] **Step 1:** Branch off develop. Verify scaffold from PR #48 exists.
- [ ] **Step 2:** Add deps: `pnpm --filter @pact-network/settler add @google-cloud/pubsub @google-cloud/secret-manager @solana/kit @solana/web3-compat bs58 axios`

### Task 1C.1: Env + secrets

**File:** `packages/settler/src/config/config.module.ts`

- [ ] **Step 1:** zod env schema: `PUBSUB_PROJECT`, `PUBSUB_SUBSCRIPTION`, `SOLANA_RPC_URL`, `SETTLEMENT_AUTHORITY_SECRET` (Secret Manager resource path), `PROGRAM_ID`, `INDEXER_URL`, `INDEXER_PUSH_SECRET`, `LOG_LEVEL`.
- [ ] **Step 2:** SecretLoaderService — fetches `SETTLEMENT_AUTHORITY_SECRET` from Secret Manager on bootstrap, decodes base58, holds the keypair in memory.
- [ ] **Step 3:** Test SecretLoader with mocked `@google-cloud/secret-manager`. Commit: `feat(settler): config + secret loader`

### Task 1C.2: ConsumerService — Pub/Sub pull (TDD)

**File:** `packages/settler/src/consumer/consumer.service.ts`

NestJS service that wraps `PubSub.subscription(...).on("message", ...)`. Maintains an in-memory queue of unprocessed messages.

- [ ] **Step 1:** Test with mock PubSub:
  - `enqueue` callback called for each received message
  - `ack(messageId)` called on confirmed batch
  - On error during processing, message is `nack`ed (will redeliver)

- [ ] **Step 2-5:** Implement, run, commit.

### Task 1C.3: BatcherService (TDD)

**File:** `packages/settler/src/batcher/batcher.service.ts`

Accumulates messages from ConsumerService. Flushes when:
- Queue size reaches `MAX_BATCH_SIZE = 50`
- Or 5s have passed since first message arrived

- [ ] **Step 1:** Tests:
  - Pushes 49 messages, no flush
  - 50th triggers flush of all 50
  - 5s after first message with only 3 in queue triggers flush of 3
  - Flush yields a `SettleBatch` with `eventIds[]` and `events[]`

- [ ] **Step 2-5:** TDD using `vi.useFakeTimers()`. Commit.

### Task 1C.4: SubmitterService (TDD)

**File:** `packages/settler/src/submitter/submitter.service.ts`

Builds the `settle_batch` ix via Codama client (Wave 1A output), signs with secret, sends to RPC, retries 3x.

- [ ] **Step 1:** Tests with mocked Codama + RPC:
  - Happy: build ix, sign, send, return signature
  - First send fails, second succeeds → returns signature, 1 retry
  - All 3 fail → throws `BatchSubmitError`

- [ ] **Step 2-5:** Implement using `@solana/kit` `sendAndConfirmTransactionFactory`. Commit.

### Task 1C.5: IndexerPusher (TDD)

**File:** `packages/settler/src/indexer/indexer-pusher.service.ts`

- [ ] **Step 1:** Test with mocked axios:
  - On batch confirmed, POSTs `{ signature, events: [...] }` to `INDEXER_URL/events` with bearer token
  - On 5xx, retries 3x; logs persistent failure but doesn't block

- [ ] **Step 2-5:** Implement, commit.

### Task 1C.6: Wire it together — AppModule

**File:** `packages/settler/src/app.module.ts`

NestJS module imports ConsumerModule, BatcherModule, SubmitterModule, IndexerModule. App bootstrap:
1. ConsumerService starts
2. On message → BatcherService.push(message)
3. BatcherService.flush() → SubmitterService.submit(batch)
4. On submit success → IndexerPusher.push + Consumer.ackAll(eventIds)
5. On submit fail → log + alert + don't ack (will redeliver)

- [ ] **Step 1:** Wire via DI.
- [ ] **Step 2:** Add `/health` endpoint that reports `lag_ms` since last successful submit.
- [ ] **Step 3:** Add `/metrics` Prometheus endpoint with `prom-client`.
- [ ] **Step 4:** End-to-end local test with mocked Pub/Sub + RPC + indexer: send 5 messages, verify all 5 settled in one batch + indexer received push.
- [ ] **Step 5:** Commit: `feat(settler): wire pipeline`

### Task 1C.7: Dockerfile + Cloud Run deploy

Same pattern as 1B.13 + 1B.14 but for settler.

- [ ] **Step 1:** Dockerfile.
- [ ] **Step 2:** `scripts/deploy-settler.sh`:

```bash
gcloud run deploy pact-settler \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --service-account="pact-settler@$GCP_PROJECT.iam.gserviceaccount.com" \
  --set-env-vars="PUBSUB_PROJECT=$GCP_PROJECT,PUBSUB_SUBSCRIPTION=pact-settle-events-settler,SOLANA_RPC_URL=$SOLANA_RPC_URL,PROGRAM_ID=$PROGRAM_ID,INDEXER_URL=$INDEXER_URL,LOG_LEVEL=info" \
  --set-secrets="SETTLEMENT_AUTHORITY_KEY=pact-settlement-authority-devnet:latest,INDEXER_PUSH_SECRET=pact-indexer-push-secret:latest" \
  --no-allow-unauthenticated \
  --min-instances=1 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu-always-allocated
```

- [ ] **Step 3:** First create `pact-indexer-push-secret`: `openssl rand -hex 32 | gcloud secrets create pact-indexer-push-secret --data-file=-`. Grant settler + indexer service accounts secretAccessor on it.
- [ ] **Step 4:** Deploy. Verify `/health` reachable via internal Cloud Run URL (or temporarily allow-unauthenticated for smoke test, then revert).
- [ ] **Step 5:** Commit, push branch, open PR.

---

## Wave 1D — `pact-indexer` (NestJS on Cloud Run) [Network rails]

> **Layering note:** Indexer + `@pact-network/db` are part of the public Network rails — they expose the read side of the protocol (call history, scorecard, refund proofs) that any market interface (or third party) consumes.

**Branch:** `feat/pact-market-indexer`
**Owner:** Crew agent `indexer-crew`
**Depends on:** Wave 0 (Cloud SQL), Wave 1A Codama client at integration.

### Task 1D.0: Branch + scaffold check

- [ ] **Step 1:** Branch off develop. Verify scaffold exists.
- [ ] **Step 2:** Deps: `pnpm --filter @pact-network/indexer add @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/config @nestjs/schedule prisma @prisma/client zod tweetnacl bs58 @solana/kit`

### Task 1D.1: Prisma schema for Pact Market

**File:** `packages/db/prisma/schema.prisma`

- [ ] **Step 1:** Replace placeholder model with full schema from spec §5.1 (Endpoint, Agent, Call, Settlement, PoolState, DemoAllowlist, OperatorAllowlist).
- [ ] **Step 2:** Generate migration:

```bash
cd packages/db
pnpm prisma migrate dev --name pact_market_v1 --create-only
```

- [ ] **Step 3:** Review generated SQL in `packages/db/prisma/migrations/<timestamp>_pact_market_v1/migration.sql`. Verify table names, indexes match spec.
- [ ] **Step 4:** Commit: `feat(db): pact market schema migration`

### Task 1D.2: Webhook controller (TDD)

**File:** `packages/indexer/src/events/events.controller.ts`

- [ ] **Step 1:** Test:
  - POST `/events` with valid bearer + payload → 200; rows upserted
  - POST without bearer → 401
  - POST with valid bearer + duplicate call_id → 200 (idempotent, no double-write)

- [ ] **Step 2:** Implement using Prisma `upsert`. Bearer guard. Use `@nestjs/common` decorators.
- [ ] **Step 3:** Commit.

### Task 1D.3: Stats service (TDD)

**File:** `packages/indexer/src/stats/stats.service.ts`

- [ ] **Step 1:** Test: `getStats()` returns aggregates from `calls`, `settlements`, `pool_state`. 5s in-memory cache.
- [ ] **Step 2-5:** Implement, commit.

### Task 1D.4: Endpoint + agent + call read endpoints

**File:** `packages/indexer/src/api/{endpoints,agents,calls}.controller.ts`

Per spec §3.4 routes. Each is a thin controller wrapping a Prisma query.

- [ ] **Step 1-5:** TDD each. Commit each.

### Task 1D.5: Operator ops controller — signed message verify

**File:** `packages/indexer/src/ops/ops.controller.ts`

- [ ] **Step 1:** Test:
  - POST `/api/ops/pause` with `{slug, paused, signature, signerPubkey}` where pubkey IN OperatorAllowlist + signature valid → returns unsigned `pause_endpoint` tx
  - Same with pubkey NOT in allowlist → 401
  - Invalid signature → 401

- [ ] **Step 2-5:** Use `nacl.sign.detached.verify`. Build unsigned tx via Codama client. Commit.

### Task 1D.6: Dockerfile + Cloud Run deploy

Pattern matches 1B/1C. `gcloud run deploy pact-indexer` with Cloud SQL connector + INDEXER_PUSH_SECRET. 

- [ ] **Step 1-5:** Dockerfile, deploy script, deploy, verify, commit.

### Task 1D.7: Apply Prisma migration to Cloud SQL

- [ ] **Step 1:** Set up Cloud SQL Auth Proxy locally:

```bash
cloud-sql-proxy $CLOUDSQL_INSTANCE --port=5432 &
```

- [ ] **Step 2:** Apply migration: `cd packages/db && DATABASE_URL=$PG_URL pnpm prisma migrate deploy`
- [ ] **Step 3:** Verify tables exist: `psql $PG_URL -c "\dt"`. Expect 7 tables.
- [ ] **Step 4:** Stop proxy, commit migration: already done in 1D.1.

---

## Wave 1E — `pact-dashboard` (Next.js on Vercel) [Market interface]

> **Layering note:** This package will be renamed `@pact-network/dashboard` → `@pact-network/market-dashboard` in Step B of the layering refactor (see `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md`). It is the customer-facing surface of Pact's market interface — separate from the public scorecard, which lives on the Network-rails side.

**Branch:** `feat/pact-market-dashboard`
**Owner:** Crew agent `dashboard-crew`
**Depends on:** indexer URL at integration time. Can develop against mocked APIs first.

### Task 1E.0: Branch + Next 15 verify

- [ ] **Step 1:** Branch off develop. Verify scaffold exists, `pnpm --filter @pact-network/dashboard build` passes (post-PR-#48 fix).

### Task 1E.1: Tailwind 4 + shadcn-style baseline

**File:** `packages/dashboard/app/globals.css`, `packages/dashboard/components/ui/`

- [ ] **Step 1:** Configure Tailwind 4 theme to use spec brand: `#151311` background, `#B87333` copper, `#C9553D` burnt sienna, `#5A6B7A` slate, Inria Serif/Sans, JetBrains Mono.
- [ ] **Step 2:** Add basic shadcn primitives: button, card, table, badge. Use `npx shadcn@latest add` or hand-roll matching the new-york style.
- [ ] **Step 3:** Commit: `feat(dashboard): brand baseline + shadcn primitives`

### Task 1E.2: Wallet adapter setup

**File:** `packages/dashboard/components/wallet-provider.tsx`

- [ ] **Step 1:** Add deps: `@solana/wallet-adapter-react @solana/wallet-adapter-react-ui @solana/wallet-adapter-wallets @solana/web3.js`
- [ ] **Step 2:** Provider wraps app, supports Phantom, Solflare, Backpack on devnet.
- [ ] **Step 3:** Add `<WalletMultiButton/>` to layout header.
- [ ] **Step 4:** Test: render Storybook or local dev, click connect, wallet adapter UI opens. Commit.

### Task 1E.3: useAgentInsurableState hook (TDD) — §3.1.2

**File:** `packages/dashboard/lib/hooks/useAgentInsurableState.ts` (replaces the old `useAgentWallet` hook)

Reads the agent's USDC ATA balance + SPL Token `delegated_amount` (allowance) via RPC every 5s while a wallet is connected. Exposes `{ ataBalance, allowance, eligible }`. There is no `AgentWallet` PDA and no `pendingRefund` — under §3.1.2, refunds land directly in the agent's USDC ATA, so the same `ataBalance` re-read picks them up automatically on the next poll.

- [ ] **Step 1:** Test with mocked RPC client: ATA decode, `delegated_amount` decode, missing-ATA case (returns zeros), revoked-delegate case (`allowance = 0n`).
- [ ] **Step 2-5:** Implement, run, commit: `feat(dashboard): useAgentInsurableState (replaces useAgentWallet)`

### Task 1E.4: Approval / Revoke buttons (no claim flow exists) — §3.1.2

**File:** `packages/dashboard/components/ApprovalControls.tsx`

There is no `RefundClaimer` hook or `claim_refund` ix in V1 (§3.1.2). The dashboard surfaces three direct SPL Token actions instead, all built via the wallet adapter against the standard SPL Token program (no protocol-side instruction):
1. **Approve** — emits SPL Token `Approve(agent_usdc_ata, settlement_authority_pda, allowance)` (default $25)
2. **Top-up approval** — same as Approve but only shown when current `delegated_amount` is exhausted
3. **Stop insurance** — emits SPL Token `Revoke(agent_usdc_ata)`

- [ ] **Step 1:** Test each control builds the correct vanilla SPL Token ix (no Codama call to the Pact program).
- [ ] **Step 2:** Test post-Approve/Revoke, `useAgentInsurableState` re-reads and the banner state updates within 5s.
- [ ] **Step 3-5:** Implement, commit: `feat(dashboard): SPL Approve/Revoke controls (no claim flow under §3.1.2)`

### Task 1E.5: `/` Overview page

**File:** `packages/dashboard/app/page.tsx`

- [ ] **Step 1:** Server-side fetches `/api/stats` from indexer (5s revalidate).
- [ ] **Step 2:** Hero stat cards: total premiums, total refunds, calls insured, pool balance (RPC live read).
- [ ] **Step 3:** Recent events stream (last 50 calls from `/api/calls?limit=50&order=ts.desc`).
- [ ] **Step 4:** Smoke test in dev. Commit.

### Task 1E.6: `/endpoints` page

**File:** `packages/dashboard/app/endpoints/page.tsx`

- [ ] **Step 1:** Server-fetch `/api/endpoints`. Render `<EndpointTable/>` with stats.
- [ ] **Step 2:** Commit.

### Task 1E.7: `/agents/[pubkey]` page (§3.1.2 — no auto-claim, no deposit/withdraw)

**File:** `packages/dashboard/app/agents/[pubkey]/page.tsx`

- [ ] **Step 1:** Server-fetch `/api/agents/[pubkey]` for history (off-chain stats aggregated from `CallRecord` rows by indexer; no AgentWallet PDA exists).
- [ ] **Step 2:** Client component uses `useAgentInsurableState` for live `{ ataBalance, allowance, eligible }`. No `useRefundClaimer` — refunds land directly in the agent's USDC ATA inside `settle_batch` (§3.1.2), so the next poll just shows the new balance.
- [ ] **Step 3:** Render: USDC ATA balance card, current SPL approval / `delegated_amount` allowance, lifetime premiums + refunds (from indexer aggregates), call history table, Approve / Top-up approval / Stop insurance buttons (Task 1E.4). No deposit/withdraw/claim buttons.
- [ ] **Step 4:** Wire Approve button: client builds vanilla SPL Token `Approve(agent_usdc_ata, settlement_authority_pda, 25_000_000)` ix; wallet adapter signs (no Codama call into the Pact program — `deposit_usdc` no longer exists).
- [ ] **Step 5:** "Get devnet USDC" button: `requestAirdrop(1 SOL)`, then link to https://faucet.circle.com, then poll user's USDC ATA balance until positive (then unlock the Approve step).
- [ ] **Step 6:** Commit.

### Task 1E.8: Vercel deploy

- [ ] **Step 1:** Link to Vercel: `cd packages/dashboard && vercel link`
- [ ] **Step 2:** Set env vars on preview env: NEXT_PUBLIC_PROGRAM_ID, NEXT_PUBLIC_SOLANA_RPC, NEXT_PUBLIC_PROXY_URL, NEXT_PUBLIC_INDEXER_URL.
- [ ] **Step 3:** `vercel --prod` from packages/dashboard.
- [ ] **Step 4:** Note Vercel preview URL. Push branch, open PR.

---

## Wave 2 — Integration (Captain, Wed PM) [cross-cutting]

**Owner:** Captain (Alan + assistant). Sequential.

### Task 2.1: Merge Wave 1 PRs

- [ ] **Step 1:** Once each Wave 1 PR is approved + tests green, merge in order: 1A (program), 1D (indexer schema), 1B (proxy), 1C (settler), 1E (dashboard).
- [ ] **Step 2:** Verify `develop` builds clean: `pnpm install --frozen-lockfile && pnpm build && pnpm test`.

### Task 2.2: DNS

- [ ] **Step 1:** In GCloud DNS, add CNAMEs:
  - `market.pactnetwork.io` → proxy Cloud Run URL
  - `indexer.pactnetwork.io` → indexer Cloud Run URL
  - `dashboard.pactnetwork.io` → Vercel deployment domain (use Vercel's instructions)
- [ ] **Step 2:** Verify TLS provisioning (Cloud Run auto-provisions for custom domains; Vercel auto). Wait up to 15 min.
- [ ] **Step 3:** `curl https://market.pactnetwork.io/health` — 200.

### Task 2.3: Seed scripts

**Files:** `scripts/seed-endpoints.ts`, `scripts/seed-allowlists.ts`

- [ ] **Step 1:** `seed-endpoints.ts`: prerequisite — `initialize_treasury` and `initialize_protocol_config` (both singletons; default fee template `[Treasury 10%, AffiliateAta(market_treasury) 5%]`) must be run once before any endpoint registration. Then connects to Cloud SQL, runs `register_endpoint` on-chain for helius/birdeye/jupiter (each call atomically creates that endpoint's per-endpoint CoveragePool + USDC vault per §3.1.1, and inherits the protocol-default fee_recipients per §3.1.3), then INSERTs corresponding rows in `endpoints` table:

```
helius:   flat=500, percent=0, sla=1200, imputed=1000, cap=10_000_000
birdeye:  flat=300, percent=0, sla=800,  imputed=800,  cap=10_000_000
jupiter:  flat=300, percent=0, sla=600,  imputed=1000, cap=10_000_000
```

- [ ] **Step 2:** Run: `pnpm tsx scripts/seed-endpoints.ts`
- [ ] **Step 3:** Verify on-chain: `solana account <endpoint_pda>`. Verify in DB: `SELECT * FROM endpoints`.
- [ ] **Step 4:** `seed-allowlists.ts`: INSERT Rick's wallet + Alan's wallet into `demo_allowlist` + `operator_allowlist`. Run.
- [ ] **Step 5:** Reload proxy registry: `curl -X POST -H "Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN" https://market.pactnetwork.io/admin/reload-endpoints`
- [ ] **Step 6:** Commit scripts.

### Task 2.4: Top up coverage pools (per-endpoint, §3.1.1)

- [ ] **Step 1:** Use the pool authority wallet (you, Alan, on devnet) to airdrop 1000 devnet USDC to its ATA via Circle faucet.
- [ ] **Step 2:** Run `scripts/top-up-pool.ts` once **per endpoint** — `top_up_coverage_pool(slug, amount)` is now scoped per slug (§3.1.1). For Wed scope: top up helius, birdeye, jupiter at e.g. ~330 devnet USDC each (split of the 1000 USDC pool seed).
- [ ] **Step 3:** Verify each endpoint's CoveragePool.current_balance independently.

### Task 2.5: e2e-devnet.sh — gate test

**File:** `scripts/e2e-devnet.sh`

Per spec §7.2.

- [ ] **Step 1:** Author script.
- [ ] **Step 2:** Run twice. Both pass.
- [ ] **Step 3:** Commit.

### Task 2.6: Manual smoke test before Rick demo

- [ ] **Step 1:** Connect Phantom (devnet), get 1 devnet SOL via Solana faucet.
- [ ] **Step 2:** Load https://dashboard.pactnetwork.io. Connect wallet.
- [ ] **Step 3:** Get devnet USDC via Circle faucet. Click "Approve $25 spending allowance" — emits standard SPL Token `Approve(agent_usdc_ata, settlement_authority_pda, 25_000_000)` (§3.1.2; vanilla SPL Token call, no `deposit_usdc` instruction exists).
- [ ] **Step 4:** Make 3 insured calls via:

```bash
curl -X POST "https://market.pactnetwork.io/v1/helius/?api-key=$HELIUS_KEY&pact_wallet=$WALLET" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["$WALLET"]}'
```

  - Each returns 200 with `X-Pact-*` headers.
  - Within 6s, settle on devnet.
  - Within 10s, indexer Postgres has 3 rows.

- [ ] **Step 5:** Force-breach: `curl ".../v1/helius/?...&pact_wallet=$WALLET&demo_breach=1" -d ...`. Refund lands directly in the agent's USDC ATA inside `settle_batch` (§3.1.2) — dashboard's next 5s poll re-reads the ATA and shows the increased balance. No claim step.
- [ ] **Step 6:** If anything is broken, fix before evening demo.

### Task 2.7: Rick walkthrough — Wed evening

Demo per spec §8.4.

---

## Wave 3 — Thu/Fri features [cross-cutting]

> **Layering note:** Tasks here span both layers. The CLI (Task 3.4) is a generic agent-side surface and is **[Network rails]**. The dashboard tour (3.1), backfill (3.3), `/ops` console (3.5), and Telegram alerts (3.6) are **[Market interface]** or operator infra. New endpoints (3.2) are market-registry data, **[Market interface]**.

### Task 3.1: Driver.js Colosseum tour

**File:** `packages/dashboard/app/_components/demo-tour.tsx`

- [ ] **Step 1:** Add deps: `pnpm --filter @pact-network/dashboard add driver.js`
- [ ] **Step 2:** Mount on `/?demo=1`. 5-step tour: hero → click endpoint → connect wallet → make insured call → force breach → see refund.
- [ ] **Step 3:** Test with judges/internal mock-judge. Commit.

### Task 3.2: 4th + 5th endpoints (Elfa, fal.ai)

- [ ] **Step 1:** Get Elfa endpoint shape from Rick (currently TBD). 
- [ ] **Step 2:** Implement `packages/proxy/src/endpoints/elfa.ts` per the answer + tests.
- [ ] **Step 3:** Same for fal.ai (use 1% percent_bps premium per PRD §7.5; classify HTTP 422 → user_error).
- [ ] **Step 4:** Register both endpoints on devnet via seed-endpoints.ts updated.
- [ ] **Step 5:** Commit.

### Task 3.3: Backfill admin endpoint

**File:** `packages/indexer/src/admin/backfill.controller.ts`

- [ ] **Step 1:** POST `/admin/backfill` (bearer-gated). Args: `since: ISO8601`. Walks `getSignaturesForAddress(programId, {until: since})`, fetches each tx, parses logs, upserts rows.
- [ ] **Step 2:** Test, commit.

### Task 3.4: Pact CLI (Friday) [Network rails]

**Branch:** `feat/pact-cli`
**Files:** `packages/cli/`

Per spec §1.2, the CLI surface is `pact run` + `pact approve | revoke | balance | history` (SPL approval custody — no `deposit`/`claim` commands; those instructions don't exist under §3.1.2).

- [ ] **Step 1:** Scaffold new package `@pact-network/cli` with commander.js or yargs.
- [ ] **Step 2:** `pact run <script>` — wraps `node`, intercepts `fetch` to inject `?pact_wallet`.
- [ ] **Step 3:** `pact balance` — reads agent's USDC ATA balance + SPL `delegated_amount` via RPC; prints `{ ataBalance, allowance, eligible }`. No AgentWallet PDA exists.
- [ ] **Step 4:** `pact approve <amount>` — builds + signs + submits a vanilla SPL Token `Approve(agent_usdc_ata, settlement_authority_pda, amount)` ix. Replaces the old `pact deposit`.
- [ ] **Step 5:** `pact revoke` — builds + signs + submits a vanilla SPL Token `Revoke(agent_usdc_ata)` ix. Stops insurance cleanly. Replaces the old withdrawal flow.
- [ ] **Step 6:** `pact history` — lists last N calls (premiums + breach refunds inline) via `/api/agents/:pubkey/calls?limit=N`. No separate `pact refunds` — refunds are just rows in history under §3.1.2 (no claim step).
- [ ] **Step 7:** No `pact claim` — `claim_refund` is removed (§3.1.2). Refunds land directly in the agent's USDC ATA inside `settle_batch`; `pact balance` re-reads to confirm.
- [ ] **Step 8:** SKILL.md repo (`solder-build/pact-market-skill`) per PRD §16.
- [ ] **Step 9:** Test against the live devnet stack. Commit.

### Task 3.5: `/ops` operator console

**File:** `packages/dashboard/app/ops/page.tsx`

- [ ] **Step 1:** Wallet-gate route: must be in OperatorAllowlist (verified via signed msg to indexer ops endpoint).
- [ ] **Step 2:** Forms for pause/unpause endpoints, update config, top-up pool. Each builds unsigned tx via indexer ops API, wallet signs.
- [ ] **Step 3:** Test, commit.

### Task 3.6: Telegram alert webhook

- [ ] **Step 1:** Create Telegram bot, save token to Secret Manager.
- [ ] **Step 2:** Cloud Function or simple Cloud Run service that accepts POST from Cloud Monitoring + posts to Telegram.
- [ ] **Step 3:** Configure 4 Cloud Monitoring alerts: settler queue lag > 60s, pool balance < 500 USDC equivalent, proxy 5xx > 5%, indexer write failures > 10/min.
- [ ] **Step 4:** Test with a synthetic alert. Commit.

---

## Wave 4 — Pre-mainnet (Sat-Sun May 9-10) [infra]

PRD §20 checklist applied to our stack. Each item is a task.

### Task 4.1: Generate mainnet keys

- [ ] **Step 1:** Generate fresh `pool-authority-mainnet.json` and `settlement-authority-mainnet.json` keypairs locally.
- [ ] **Step 2:** Store base58-encoded keys in Secret Manager (new versions for mainnet): `pact-pool-authority-mainnet`, `pact-settlement-authority-mainnet`.
- [ ] **Step 3:** Backup all keypair files in 1Password vault `pact-market-mainnet-keys`.
- [ ] **Step 4:** Shred local files.

### Task 4.2: Deploy program to mainnet

- [ ] **Step 1:** Switch CLI: `solana config set --url https://api.mainnet-beta.solana.com`
- [ ] **Step 2:** Fund deployer wallet with ~0.5 SOL.
- [ ] **Step 3:** Generate program keypair (or reuse from devnet — preferable for ID stability if upgrade auth retained).
- [ ] **Step 4:** Deploy: `solana program deploy --program-id <program-keypair> --url mainnet ...`
- [ ] **Step 5:** Update `packages/shared/src/version.ts` `PROGRAM_ID_MAINNET`.

### Task 4.3: Initialize mainnet state

- [ ] **Step 1:** Pool authority signs `initialize_settlement_authority(<settlement_pubkey>)` on mainnet.
- [ ] **Step 2:** Pool authority signs `initialize_treasury` and `initialize_protocol_config` on mainnet (§3.1.3 singletons; mainnet USDC mint).
- [ ] **Step 3:** Pool authority signs `register_endpoint` for all 5 slugs — each call atomically creates that endpoint's per-endpoint CoveragePool + USDC vault per §3.1.1 (no separate `initialize_coverage_pool` step exists).

### Task 4.4: Deploy Cloud Run services with mainnet env

- [ ] **Step 1:** Update each deploy script's env to point at mainnet RPC (Helius mainnet) + mainnet PROGRAM_ID + mainnet Secret Manager refs.
- [ ] **Step 2:** Deploy proxy, settler, indexer.
- [ ] **Step 3:** Deploy dashboard with `NEXT_PUBLIC_PROGRAM_ID=<mainnet>`, `NEXT_PUBLIC_SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...`. Remove "Get devnet USDC" button.
- [ ] **Step 4:** Smoke test mainnet with one of Rick/Alan's wallets and $5 USDC.

### Task 4.5: $200 pool seed (split per endpoint, §3.1.1)

- [ ] **Step 1:** Pool authority sends 200 mainnet USDC to its ATA.
- [ ] **Step 2:** Run `top_up_coverage_pool(slug, amount)` once per endpoint (§3.1.1 — pools are per-slug, not singleton); split the 200 USDC across the 5 launch endpoints. Suggested initial split: helius 60, birdeye 40, jupiter 40, elfa 30, fal.ai 30 (in USDC; pool authority can rebalance later via additional top-ups).

### Task 4.6: Pre-mainnet checklist gate

PRD §20 checklist:
- [ ] All Pinocchio tests pass on the deployed program (re-run via cluster query)
- [ ] All proxy tests pass
- [ ] All settler tests pass
- [ ] e2e-devnet.sh equivalent for mainnet (e2e-mainnet.sh) passes
- [ ] Load test 200 RPS for 30 min, no errors (use k6)
- [ ] Settlement authority key in Secret Manager with restricted IAM
- [ ] Pool authority key in Secret Manager with restricted IAM
- [ ] Both keys backed up in 1Password
- [ ] All `.env` files gitignored (verify `git ls-files | grep .env` returns nothing)
- [ ] No `console.log` of query strings or secrets in proxy
- [ ] CORS configured: dashboard origin only allowed for `/api/ops/*`
- [ ] Operator allowlist seeded
- [ ] Telegram alerts wired
- [ ] Solscan verifies mainnet program ID
- [ ] Treasury seed deposit successful
- [ ] One synthetic breach + refund e2e on mainnet (use force-breach with $0.001 imputed-cost test endpoint, document)

---

## Wave 5 — Colosseum submission (Mon May 11) [cross-cutting]

### Task 5.1: SKILL.md repo published

- [ ] **Step 1:** Create `solder-build/pact-market-skill` repo on GitHub.
- [ ] **Step 2:** Author `SKILL.md`, `README.md`, `LICENSE`, `examples/` per PRD §16.
- [ ] **Step 3:** Test locally: `npx skills add ./pact-market-skill` against a test project.
- [ ] **Step 4:** Push to GitHub, submit to Solana Foundation skill registry.

### Task 5.2: Final dossier + submission

- [ ] **Step 1:** Compile demo recording.
- [ ] **Step 2:** Write the Colosseum submission narrative.
- [ ] **Step 3:** Submit.

---

## Self-Review

**Spec coverage check:**
- §1 Scope: covered Wave 0 (GCP) + 1A-E (5 packages) + Wave 4 (mainnet) + Wave 5 (Colosseum). ✓
- §2 Architecture: implicit in tasks; each task references the right component. ✓
- §3 Components: each component has a Wave 1 stream with full task breakdown. ✓
- §4 Data flow: tested in Task 2.5 e2e + per-component tests. ✓
- §5 State stores: schema in 1D.1, allowlists in 2.3, pool seed in 2.4 + 4.5. ✓
- §6 Error handling: covered in unit tests across waves. ✓
- §7 Testing: each task has TDD steps; integration script in 2.5. ✓
- §8 Deployment plan: Wave 2 + Wave 4 cover devnet + mainnet rollouts. ✓
- §9 Drop ladder: not codified as tasks (it's a captain runtime choice); referenced inline. ✓
- §10 Open product questions deferred: Task 3.2 explicitly waits for Rick on Elfa endpoint shape. ✓
- §11 Risk register: addressed inline (compute budget in 1A.16, cold start in 1B.14 + 1C.7 min-instances=1, Pub/Sub setup in Wave 0). ✓

**Placeholder scan:** Tasks 3.2 (Elfa endpoint shape) and 4.6 checklist contain TBDs that are deferred to Rick's input. These are acceptable because they're explicitly product-blocked, not engineer-blocked. No internal placeholders.

**Type consistency check:**
- `EndpointConfig` field names consistent across 1A.4 (Rust state) and 1B.3 (TS Endpoint registry types — note camelCase vs snake_case is per-language but field semantics match). EndpointConfig now carries `coverage_pool: Pubkey` (§3.1.1) and a `fee_recipients: [FeeRecipient; 8]` array (§3.1.3) — clients resolve the per-endpoint pool by reading this field rather than re-deriving the PDA on every call.
- `SettlementEvent` byte layout in 1A.16 matches what proxy emits in 1B.7 (both use `call_id, agent_pubkey, endpoint_slug, premium_lamports, refund_lamports, latency_ms, breach, timestamp` — agent identifier is the agent's wallet pubkey, NOT a PDA, per §3.1.2).
- `FeeRecipient` is 48 bytes per spec §3.1.3; the on-chain `EndpointConfig.fee_recipients` array is 8 × 48 = 384 bytes; consumers use the Codama-generated TS struct decoder.
- `SettlementStatus` enum (`Settled` / `DelegateFailed`) is consistent across 1A.4 (Rust state), the §3.1.2 pre-flight delegate check in 1A.16, and indexer-side flagging in 1D.

**Note on removed-instruction surface:** Under the V1 spec (§3.1.1, §3.1.2, §3.1.3), the program no longer exposes `initialize_coverage_pool`, `initialize_agent_wallet`, `deposit_usdc`, `request_withdrawal`, `execute_withdrawal`, or `claim_refund`. The first is folded into `register_endpoint`; the rest are obsolete because agent custody is via SPL Token approval and refunds land directly in the agent's USDC ATA. Any task referencing those instructions in this plan has been rewritten or marked removed (Tasks 1A.6, 1A.11–1A.14, 1A.17). Consumers (1B, 1C, 1E, 3.4) align to the new shape.
