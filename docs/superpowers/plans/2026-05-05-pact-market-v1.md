# Pact Market V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Pact Market V1 — a parametric API insurance proxy on Solana — to public devnet by Wed May 6, mainnet by Mon May 11 (Colosseum submission).

**Architecture:** Five-unit system on GCP. Cloud Run services for proxy (Hono), settler (NestJS), indexer (NestJS); Pub/Sub event queue between proxy and settler; Cloud SQL Postgres for per-call history; Vercel-hosted Next.js dashboard; new `pact-market-pinocchio` Pinocchio crate on Solana. Settlement authority hot key stored in GCP Secret Manager. Refunds settle on-chain to AgentWallet PDA, dashboard auto-claims to client wallet via new `claim_refund` instruction.

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

> **Layering note:** This crate will be renamed to `pact-network-v1-pinocchio` as part of Step B in the layering refactor (see `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md`). The on-chain program will absorb four substantive changes during that refactor — per-endpoint coverage pools, agent custody via SPL Token approval (instead of a custodial AgentWallet PDA), interchangeable fee recipients, and an explicit treasury account. Tasks below describe the V1 design as currently scoped; the layering plan tracks the V2 follow-ups.

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
│   ├── state.rs            # CoveragePool, EndpointConfig, AgentWallet, CallRecord, SettlementAuthority
│   ├── error.rs            # PactError enum 6000..6015
│   ├── pda.rs              # seed derivation helpers
│   ├── discriminator.rs    # 1-byte instruction discriminators
│   ├── constants.rs        # USDC mint, MAX_BATCH_SIZE, etc.
│   ├── token.rs            # SPL Token CPI helpers (vendored if not in pinocchio-token-program)
│   └── instructions/
│       ├── mod.rs
│       ├── initialize_coverage_pool.rs
│       ├── initialize_settlement_authority.rs
│       ├── register_endpoint.rs
│       ├── update_endpoint_config.rs
│       ├── pause_endpoint.rs
│       ├── initialize_agent_wallet.rs
│       ├── deposit_usdc.rs
│       ├── request_withdrawal.rs
│       ├── execute_withdrawal.rs
│       ├── top_up_coverage_pool.rs
│       ├── settle_batch.rs
│       └── claim_refund.rs
└── tests/
    ├── 01-pool.ts
    ├── 02-endpoint.ts
    ├── 03-agent-wallet.ts
    ├── 04-deposit-withdraw.ts
    ├── 05-settle-batch.ts
    ├── 06-pause.ts
    ├── 07-exposure-cap.ts
    └── 08-claim-refund.ts
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
        0 => instructions::initialize_coverage_pool::process(program_id, accounts, ix_data),
        1 => instructions::initialize_settlement_authority::process(program_id, accounts, ix_data),
        2 => instructions::register_endpoint::process(program_id, accounts, ix_data),
        3 => instructions::update_endpoint_config::process(program_id, accounts, ix_data),
        4 => instructions::pause_endpoint::process(program_id, accounts, ix_data),
        5 => instructions::initialize_agent_wallet::process(program_id, accounts, ix_data),
        6 => instructions::deposit_usdc::process(program_id, accounts, ix_data),
        7 => instructions::request_withdrawal::process(program_id, accounts, ix_data),
        8 => instructions::execute_withdrawal::process(program_id, accounts, ix_data),
        9 => instructions::top_up_coverage_pool::process(program_id, accounts, ix_data),
        10 => instructions::settle_batch::process(program_id, accounts, ix_data),
        11 => instructions::claim_refund::process(program_id, accounts, ix_data),
        _ => Err(pinocchio::program_error::ProgramError::InvalidInstructionData),
    }
}
```

- [ ] **Step 6:** Create empty stubs to make it compile:

```bash
mkdir -p packages/program/programs-pinocchio/pact-market-pinocchio/src/instructions
for f in initialize_coverage_pool initialize_settlement_authority register_endpoint \
         update_endpoint_config pause_endpoint initialize_agent_wallet deposit_usdc \
         request_withdrawal execute_withdrawal top_up_coverage_pool settle_batch claim_refund; do
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

- [ ] **Step 7:** Create `src/instructions/mod.rs` listing all 12 instructions:

```rust
pub mod claim_refund;
pub mod deposit_usdc;
pub mod execute_withdrawal;
pub mod initialize_agent_wallet;
pub mod initialize_coverage_pool;
pub mod initialize_settlement_authority;
pub mod pause_endpoint;
pub mod register_endpoint;
pub mod request_withdrawal;
pub mod settle_batch;
pub mod top_up_coverage_pool;
pub mod update_endpoint_config;
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

// Withdrawal cooldown
pub const WITHDRAWAL_COOLDOWN_SECS: i64 = 86_400;

// Deposit caps (lamports of USDC, 6 decimals)
pub const MAX_DEPOSIT_LAMPORTS: u64 = 25_000_000;  // $25
pub const MIN_PREMIUM_LAMPORTS: u64 = 100;          // $0.0001
```

NOTE: `solana_pubkey_macro` is not standard in Pinocchio. If it's unavailable, use `Pubkey::from(<bytes>)` directly with the decoded base58. Alternative implementation:

```rust
use pinocchio::pubkey::Pubkey;
use five8_const::decode_32_const;

pub const USDC_MAINNET: Pubkey = decode_32_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDC_DEVNET: Pubkey = decode_32_const("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

pub const MAX_BATCH_SIZE: usize = 50;
pub const WITHDRAWAL_COOLDOWN_SECS: i64 = 86_400;
pub const MAX_DEPOSIT_LAMPORTS: u64 = 25_000_000;
pub const MIN_PREMIUM_LAMPORTS: u64 = 100;
```

Reference how the existing `pact-insurance-pinocchio` crate handles pubkey constants — use the same pattern.

- [ ] **Step 2:** Build: `cargo build -p pact-market-pinocchio`. Expected: clean.
- [ ] **Step 3:** Commit: `git add . && git commit -m "feat(pact-market): add constants module"`

### Task 1A.2: Errors

**File:** `packages/program/programs-pinocchio/pact-market-pinocchio/src/error.rs`

- [ ] **Step 1:** Write error enum (16 variants per spec §3.1):

```rust
use pinocchio::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PactError {
    InsufficientBalance = 6000,
    EndpointPaused = 6001,
    ExposureCapExceeded = 6002,
    WithdrawalCooldownActive = 6003,
    NoPendingWithdrawal = 6004,
    UnauthorizedSettler = 6005,
    UnauthorizedAuthority = 6006,
    DuplicateCallId = 6007,
    EndpointNotFound = 6008,
    DepositCapExceeded = 6009,
    PoolDepleted = 6010,
    InvalidTimestamp = 6011,
    BatchTooLarge = 6012,
    PremiumTooSmall = 6013,
    InvalidSlug = 6014,
    ArithmeticOverflow = 6015,
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

pub const SEED_COVERAGE_POOL: &[u8] = b"coverage_pool";
pub const SEED_ENDPOINT: &[u8] = b"endpoint";
pub const SEED_AGENT_WALLET: &[u8] = b"agent_wallet";
pub const SEED_CALL: &[u8] = b"call";
pub const SEED_SETTLEMENT_AUTHORITY: &[u8] = b"settlement_authority";

pub fn derive_coverage_pool(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[SEED_COVERAGE_POOL], program_id)
}

pub fn derive_endpoint_config(program_id: &Pubkey, slug: &[u8; 16]) -> (Pubkey, u8) {
    find_program_address(&[SEED_ENDPOINT, slug], program_id)
}

pub fn derive_agent_wallet(program_id: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[SEED_AGENT_WALLET, owner.as_ref()], program_id)
}

pub fn derive_call_record(program_id: &Pubkey, call_id: &[u8; 16]) -> (Pubkey, u8) {
    find_program_address(&[SEED_CALL, call_id], program_id)
}

pub fn derive_settlement_authority(program_id: &Pubkey) -> (Pubkey, u8) {
    find_program_address(&[SEED_SETTLEMENT_AUTHORITY], program_id)
}
```

- [ ] **Step 2:** Build clean.
- [ ] **Step 3:** Commit: `feat(pact-market): add PDA derivation helpers`

### Task 1A.4: State accounts

**File:** `packages/program/programs-pinocchio/pact-market-pinocchio/src/state.rs`

Implement state structs per spec §3.1. Use `bytemuck::Pod + Zeroable` for zero-copy Pinocchio access. Reference the existing pact-insurance-pinocchio `state.rs` for the same pattern.

- [ ] **Step 1:** Write `CoveragePool`:

```rust
use bytemuck::{Pod, Zeroable};
use pinocchio::pubkey::Pubkey;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CoveragePool {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub total_deposits: u64,
    pub total_premiums: u64,
    pub total_refunds: u64,
    pub current_balance: u64,
    pub created_at: i64,
}

impl CoveragePool {
    pub const LEN: usize = 1 + 7 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8;
}
```

- [ ] **Step 2:** Write `EndpointConfig` (with new exposure cap fields):

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct EndpointConfig {
    pub bump: u8,
    pub paused: u8,
    pub _padding0: [u8; 6],
    pub slug: [u8; 16],
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
}

impl EndpointConfig {
    pub const LEN: usize = 1+1+6+16+8+2+6+4+4+8+8+8+8+8+8+8+8+8;
}
```

- [ ] **Step 3:** Write `AgentWallet`:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct AgentWallet {
    pub bump: u8,
    pub _padding0: [u8; 7],
    pub owner: Pubkey,
    pub usdc_vault: Pubkey,
    pub balance: u64,
    pub total_deposits: u64,
    pub total_premiums_paid: u64,
    pub total_refunds_received: u64,
    pub call_count: u64,
    pub pending_withdrawal: u64,
    pub withdrawal_unlock_at: i64,
    pub created_at: i64,
}

impl AgentWallet {
    pub const LEN: usize = 1+7+32+32+8+8+8+8+8+8+8+8;
}
```

- [ ] **Step 4:** Write `CallRecord`:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CallRecord {
    pub bump: u8,
    pub breach: u8,
    pub _padding0: [u8; 6],
    pub call_id: [u8; 16],
    pub agent_wallet: Pubkey,
    pub endpoint_slug: [u8; 16],
    pub premium_lamports: u64,
    pub refund_lamports: u64,
    pub latency_ms: u32,
    pub _padding1: [u8; 4],
    pub timestamp: i64,
}

impl CallRecord {
    pub const LEN: usize = 1+1+6+16+32+16+8+8+4+4+8;
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

- [ ] **Step 6:** Build: `cargo build -p pact-market-pinocchio`. Expected: clean.
- [ ] **Step 7:** Commit: `feat(pact-market): add state account layouts`

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

### Task 1A.6: `initialize_coverage_pool` instruction (TDD)

**Files:**
- Test: `tests/01-pool.ts`
- Impl: `src/instructions/initialize_coverage_pool.rs`

- [ ] **Step 1:** Write failing test in `tests/01-pool.ts`:

```ts
import { test, expect } from "bun:test";
import { LiteSVM } from "litesvm";
import { loadProgram, PROGRAM_ID } from "./_program";
import { buildInitializeCoveragePool } from "./helpers";

test("initialize_coverage_pool creates singleton with USDC vault", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const ix = buildInitializeCoveragePool({ authority: authority.publicKey });
  const result = svm.sendTransaction([ix], [authority]);
  expect(result.err).toBeNull();

  const poolPda = derivePoolPda();
  const account = svm.getAccount(poolPda);
  expect(account).not.toBeNull();
  // Decode CoveragePool, assert authority, balances zero, etc.
});
```

- [ ] **Step 2:** Run test: `cd packages/program/programs-pinocchio/pact-market-pinocchio && bun test 01-pool.ts`. Expected: FAIL.

- [ ] **Step 3:** Implement `src/instructions/initialize_coverage_pool.rs`:

```rust
use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeAccount3;

use crate::{
    constants::{USDC_DEVNET, USDC_MAINNET},
    error::PactError,
    pda::{derive_coverage_pool, SEED_COVERAGE_POOL},
    state::CoveragePool,
};

/// Accounts:
/// 0. authority (signer, writable, payer)
/// 1. coverage_pool PDA (writable, init)
/// 2. usdc_vault token account (writable, init)
/// 3. usdc_mint (read)
/// 4. system_program
/// 5. token_program
/// 6. rent sysvar
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    // Parse accounts
    let [authority, pool, vault, mint, _system_program, _token_program, _rent_sysvar, ..] =
        accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

    // Verify signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify PDA
    let (expected_pool, bump) = derive_coverage_pool(program_id);
    if pool.key() != &expected_pool {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify mint is one of the allowed USDC mints
    if mint.key() != &USDC_MAINNET && mint.key() != &USDC_DEVNET {
        return Err(PactError::EndpointNotFound.into()); // reusing error; consider InvalidMint
    }

    // Allocate pool account
    let bump_arr = [bump];
    let seeds = [Seed::from(SEED_COVERAGE_POOL), Seed::from(&bump_arr)];
    let signer = Signer::from(&seeds);
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(CoveragePool::LEN);

    CreateAccount {
        from: authority,
        to: pool,
        lamports,
        space: CoveragePool::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer.clone()])?;

    // Initialize vault as token account owned by pool PDA
    InitializeAccount3 {
        account: vault,
        mint,
        owner: pool.key(),
    }
    .invoke()?;

    // Write initial state
    let mut data = pool.try_borrow_mut_data()?;
    let pool_state: &mut CoveragePool = bytemuck::from_bytes_mut(&mut data[..CoveragePool::LEN]);
    pool_state.bump = bump;
    pool_state.authority = *authority.key();
    pool_state.usdc_mint = *mint.key();
    pool_state.usdc_vault = *vault.key();
    pool_state.total_deposits = 0;
    pool_state.total_premiums = 0;
    pool_state.total_refunds = 0;
    pool_state.current_balance = 0;
    pool_state.created_at = pinocchio::sysvars::clock::Clock::get()?.unix_timestamp;

    Ok(())
}
```

- [ ] **Step 4:** Run test: `bun test 01-pool.ts`. Expected: PASS.

- [ ] **Step 5:** Add negative test: same instruction submitted twice should fail (account already in use):

```ts
test("initialize_coverage_pool fails on duplicate", () => {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  svm.sendTransaction([buildInitializeCoveragePool({ authority: authority.publicKey })], [authority]);
  const second = svm.sendTransaction([buildInitializeCoveragePool({ authority: authority.publicKey })], [authority]);
  expect(second.err).not.toBeNull();
});
```

- [ ] **Step 6:** Run, expect PASS (CreateAccount fails on existing account).
- [ ] **Step 7:** Commit: `feat(pact-market): initialize_coverage_pool instruction + tests`

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

### Task 1A.8: `register_endpoint` (TDD)

**Files:**
- Test: `tests/02-endpoint.ts`
- Impl: `src/instructions/register_endpoint.rs`

- [ ] **Step 1:** Write tests:
  - Happy: pool authority registers "helius" endpoint with all params; account written correctly
  - Negative: non-pool-authority rejected with `UnauthorizedAuthority`
  - Negative: invalid slug (non-ASCII) rejected with `InvalidSlug`
  - Negative: register same slug twice rejected (account exists)

- [ ] **Step 2:** Run, expect FAIL.

- [ ] **Step 3:** Implement instruction. Data layout (parse with byteslice):
  - bytes 0-15: `slug: [u8; 16]`
  - bytes 16-23: `flat_premium_lamports: u64`
  - bytes 24-25: `percent_bps: u16`
  - bytes 26-29: `sla_latency_ms: u32`
  - bytes 30-37: `imputed_cost_lamports: u64`
  - bytes 38-45: `exposure_cap_per_hour_lamports: u64`

  Total: 46 bytes.

  Validate slug: every byte must be ASCII printable or 0 (null pad). If any byte > 127, return `InvalidSlug`.

- [ ] **Step 4:** Run tests, expect PASS.
- [ ] **Step 5:** Commit: `feat(pact-market): register_endpoint`

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

### Task 1A.11: `initialize_agent_wallet` (TDD)

**Files:**
- Test: `tests/03-agent-wallet.ts`
- Impl: `src/instructions/initialize_agent_wallet.rs`

- [ ] **Step 1:** Tests:
  - Happy: any wallet can initialize their own AgentWallet PDA
  - Idempotency: re-initialize fails (account already in use)

- [ ] **Step 2-5:** TDD cycle. Owner signs, creates AgentWallet PDA + USDC ATA owned by it. Commit.

### Task 1A.12: `deposit_usdc` (TDD)

**Files:**
- Test: `tests/04-deposit-withdraw.ts`
- Impl: `src/instructions/deposit_usdc.rs`

- [ ] **Step 1:** Tests:
  - Happy: deposit 5 USDC, balance updates, total_deposits + current_balance updated
  - Negative: deposit > MAX_DEPOSIT_LAMPORTS rejected with `DepositCapExceeded`
  - Negative: non-owner can't deposit (signer must be owner)

- [ ] **Step 2-5:** TDD. CPI to spl-token Transfer from owner ATA → AgentWallet vault. Commit: `feat(pact-market): deposit_usdc`

### Task 1A.13: `request_withdrawal` (TDD)

**Files:**
- Test: append to `tests/04-deposit-withdraw.ts`
- Impl: `src/instructions/request_withdrawal.rs`

- [ ] **Step 1:** Tests:
  - Happy: owner requests withdrawal of N; sets pending_withdrawal=N, withdrawal_unlock_at=now+86400
  - Negative: amount > balance rejected with `InsufficientBalance`
  - Negative: existing pending withdrawal blocks new request (or replaces? — spec says no, return WithdrawalCooldownActive)

- [ ] **Step 2-5:** TDD. Commit: `feat(pact-market): request_withdrawal`

### Task 1A.14: `execute_withdrawal` (TDD)

**File:** `src/instructions/execute_withdrawal.rs`

- [ ] **Step 1:** Tests:
  - Negative: before unlock_at, fails with `WithdrawalCooldownActive`
  - Happy: after unlock_at, transfers from AgentWallet vault → owner ATA
  - Negative: no pending withdrawal returns `NoPendingWithdrawal`

- [ ] **Step 2-5:** TDD. Use Clock sysvar. Commit.

### Task 1A.15: `top_up_coverage_pool` (TDD)

**Files:**
- Test: append to `tests/01-pool.ts`
- Impl: `src/instructions/top_up_coverage_pool.rs`

- [ ] **Step 1:** Tests:
  - Happy: pool authority top-up 100 USDC, current_balance += 100, total_deposits += 100
  - Negative: non-authority rejected

- [ ] **Step 2-5:** TDD. CPI from authority ATA → CoveragePool vault. Commit.

### Task 1A.16: `settle_batch` — the critical instruction (TDD)

**Files:**
- Test: `tests/05-settle-batch.ts`
- Impl: `src/instructions/settle_batch.rs`

This is the most complex instruction. It is THE critical path for refund correctness.

**Data layout:**
- bytes 0-1: event_count: u16 (LE)
- repeating event_count times:
  - call_id: [u8; 16]
  - agent_wallet: Pubkey (32)
  - endpoint_slug: [u8; 16]
  - premium_lamports: u64
  - refund_lamports: u64
  - latency_ms: u32
  - breach: u8 (0|1)
  - timestamp: i64

Total per event: 16+32+16+8+8+4+1+7(pad)+8 = 100 bytes.
Total ix data: 2 + 100*event_count.

**Account list:**
- 0: settlement_authority signer (signer)
- 1: settlement_authority PDA (read)
- 2: coverage_pool PDA (writable)
- 3: coverage_pool USDC vault (writable)
- 4: token_program (read)
- 5: clock sysvar (read)
- 6..: per event: [call_record PDA (writable, init-if-needed), agent_wallet PDA (writable), agent_wallet vault (writable), endpoint_config PDA (writable)]

This is dense. Document the account-list contract in the instruction's header comment.

- [ ] **Step 1:** Test: single-event batch with no breach. Premium debited from agent vault → pool vault, agent.balance updated, pool.current_balance updated, CallRecord created.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement. Skeleton:

```rust
// Pseudocode order:
// 1. verify settler signer matches settlement_authority.signer
// 2. parse event_count, ensure <= MAX_BATCH_SIZE (else BatchTooLarge)
// 3. for each event:
//    a. derive expected PDAs, verify match supplied accounts
//    b. validate timestamp <= clock.unix_timestamp (else InvalidTimestamp)
//    c. validate premium >= MIN_PREMIUM_LAMPORTS (else PremiumTooSmall)
//    d. validate endpoint not paused (else EndpointPaused)
//    e. check call_record account is uninitialized (else DuplicateCallId)
//    f. check exposure cap: if current_period_start + 3600 < now, reset period.
//       if current_period_refunds + refund > exposure_cap, set refund=0 (skip refund)
//    g. allocate CallRecord PDA via CreateAccount CPI
//    h. write CallRecord state
//    i. CPI Transfer premium: agent.vault → pool.vault (signed by agent_wallet PDA)
//    j. update agent.balance, agent.total_premiums_paid, agent.call_count
//    k. update pool.current_balance, pool.total_premiums
//    l. update endpoint.total_calls, total_premiums, current_period_refunds (if breach)
//    m. if refund > 0:
//        check pool.current_balance >= refund (else PoolDepleted, skip refund)
//        CPI Transfer refund: pool.vault → agent.vault (signed by pool PDA)
//        update pool.total_refunds, pool.current_balance, agent.total_refunds_received
```

- [ ] **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Add tests for:
  - Batch of 5 events with mixed breaches (3 success, 2 breach)
  - Duplicate call_id in same batch (second errors with DuplicateCallId)
  - Re-submission of already-settled call_id (CallRecord init fails)
  - Unauthorized settler rejected with `UnauthorizedSettler`
  - Paused endpoint event skipped or errored with `EndpointPaused`
  - Pool depleted: refund skipped silently, premium still settled
  - Batch size MAX_BATCH_SIZE+1 rejected with `BatchTooLarge`
  - Future timestamp rejected with `InvalidTimestamp`
  - Premium below MIN rejected with `PremiumTooSmall`

- [ ] **Step 6:** Run all settle_batch tests, all pass.
- [ ] **Step 7:** Commit: `feat(pact-market): settle_batch with full coverage`

### Task 1A.17: `claim_refund` (TDD)

**File:** `src/instructions/claim_refund.rs`, `tests/08-claim-refund.ts`

Refund-sweep instruction. Owner signs, transfers `amount` from AgentWallet vault → owner ATA. Cap: `amount <= total_refunds_received - total_swept_so_far` (we don't track total_swept... need to add it OR cap at vault balance directly).

Simpler design: cap at AgentWallet vault balance — so user can sweep any portion of their vault to their own ATA, within balance. This conflates refunds with deposits, which is fine since they're in the same vault.

Wait — re-reading the spec: "transfers from AgentWallet vault to owner ATA. Sweeps refunded balance to client wallet." If we cap at vault balance, the user could sweep their own deposit. That's OK for V1 — we don't really need to differentiate. But it'd defeat the purpose of `request_withdrawal/execute_withdrawal`'s 24h cooldown!

Resolution: claim_refund caps at `total_refunds_received - total_refunds_claimed`. Add a new field `total_refunds_claimed: u64` to AgentWallet. Update Task 1A.4 state def. Note: the LEN value changes; verify migrations / test alignment.

- [ ] **Step 1:** Update `state.rs` AgentWallet to add `total_refunds_claimed: u64` and increment `LEN` by 8.
- [ ] **Step 2:** Tests:
  - Happy: agent has 1 USDC refunded; calls claim_refund(0.5); 0.5 lands on owner ATA, agent.total_refunds_claimed += 0.5
  - Negative: claim_refund(amount) where amount > (total_refunds_received - total_refunds_claimed) rejected with `InsufficientBalance`
  - Negative: non-owner rejected with `MissingRequiredSignature`

- [ ] **Step 3-5:** TDD. CPI Transfer from AgentWallet vault → owner ATA, signed by AgentWallet PDA seeds. Commit: `feat(pact-market): claim_refund`

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

- [ ] **Step 2:** Verify generated client exports `getInitializeCoveragePoolInstruction`, ..., `getSettleBatchInstruction`, `getClaimRefundInstruction`. 12 functions.
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
│   │   ├── balance.ts        # RPC AgentWallet read + LRU
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

### Task 1B.5: Balance cache (TDD)

**File:** `packages/proxy/src/lib/balance.ts`

- [ ] **Step 1:** Test with mocked RPC:
  - Returns cached value within TTL
  - On expiry, re-fetches via `getAccountInfo` for AgentWallet PDA
  - Decodes `balance: u64` field correctly from raw bytes
  - On RPC error, returns 0n and logs (don't throw — agent shouldn't be blocked)

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
5. balance.get(wallet) — if < flat_premium → 402
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
- `agents/:pubkey`: read AgentWallet via RPC, return JSON snapshot

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

### Task 1E.3: useAgentWallet hook (TDD)

**File:** `packages/dashboard/lib/hooks/useAgentWallet.ts`

Reads AgentWallet PDA via RPC every 5s while wallet is connected. Exposes balance, pendingRefund, etc.

- [ ] **Step 1:** Test with mocked RPC client.
- [ ] **Step 2-5:** Implement, run, commit.

### Task 1E.4: RefundClaimer hook (TDD)

**File:** `packages/dashboard/lib/hooks/useRefundClaimer.ts`

When `pendingRefund > 0` for 2 consecutive polls (debounce against tx race), build `claim_refund` ix via Codama, sign via wallet adapter, submit, refresh.

- [ ] **Step 1-5:** TDD. Commit.

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

### Task 1E.7: `/agents/[pubkey]` page + auto-claim flow

**File:** `packages/dashboard/app/agents/[pubkey]/page.tsx`

- [ ] **Step 1:** Server-fetch `/api/agents/[pubkey]` for history.
- [ ] **Step 2:** Client component uses `useAgentWallet` + `useRefundClaimer` for live state + auto-claim.
- [ ] **Step 3:** Render: balance card, refunds-claimed total, call history table, deposit/withdraw buttons.
- [ ] **Step 4:** Wire deposit button: client builds `deposit_usdc(5_000_000)` ix via Codama, wallet signs.
- [ ] **Step 5:** "Get devnet USDC" button: `requestAirdrop(1 SOL)`, then link to https://faucet.circle.com, then poll user's USDC ATA balance.
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

- [ ] **Step 1:** `seed-endpoints.ts`: connects to Cloud SQL, runs `register_endpoint` on-chain for helius/birdeye/jupiter, then INSERTs corresponding rows in `endpoints` table:

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

### Task 2.4: Top up coverage pool

- [ ] **Step 1:** Use the pool authority wallet (you, Alan, on devnet) to airdrop 1000 devnet USDC to its ATA via Circle faucet.
- [ ] **Step 2:** Run a small script `scripts/top-up-pool.ts` that calls `top_up_coverage_pool(1_000_000_000)` (1000 USDC).
- [ ] **Step 3:** Verify CoveragePool.current_balance = 1_000_000_000.

### Task 2.5: e2e-devnet.sh — gate test

**File:** `scripts/e2e-devnet.sh`

Per spec §7.2.

- [ ] **Step 1:** Author script.
- [ ] **Step 2:** Run twice. Both pass.
- [ ] **Step 3:** Commit.

### Task 2.6: Manual smoke test before Rick demo

- [ ] **Step 1:** Connect Phantom (devnet), get 1 devnet SOL via Solana faucet.
- [ ] **Step 2:** Load https://dashboard.pactnetwork.io. Connect wallet.
- [ ] **Step 3:** Get devnet USDC via Circle faucet. Deposit 5 USDC to AgentWallet.
- [ ] **Step 4:** Make 3 insured calls via:

```bash
curl -X POST "https://market.pactnetwork.io/v1/helius/?api-key=$HELIUS_KEY&pact_wallet=$WALLET" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["$WALLET"]}'
```

  - Each returns 200 with `X-Pact-*` headers.
  - Within 6s, settle on devnet.
  - Within 10s, indexer Postgres has 3 rows.

- [ ] **Step 5:** Force-breach: `curl ".../v1/helius/?...&pact_wallet=$WALLET&demo_breach=1" -d ...`. Refund credited; dashboard auto-claims to client wallet.
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

- [ ] **Step 1:** Scaffold new package `@pact-network/cli` with commander.js or yargs.
- [ ] **Step 2:** `pact run <script>` — wraps `node`, intercepts `fetch` to inject `?pact_wallet`.
- [ ] **Step 3:** `pact balance` — reads AgentWallet PDA via RPC.
- [ ] **Step 4:** `pact deposit <amount>` — builds + signs + submits deposit_usdc tx.
- [ ] **Step 5:** `pact refunds` — lists recent refunds via `/api/agents/:pubkey/calls?breach=true`.
- [ ] **Step 6:** `pact history` — lists last N calls.
- [ ] **Step 7:** `pact claim` — calls claim_refund.
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

- [ ] **Step 1:** Pool authority signs `initialize_coverage_pool` on mainnet with mainnet USDC mint.
- [ ] **Step 2:** Pool authority signs `initialize_settlement_authority(<settlement_pubkey>)`.
- [ ] **Step 3:** Pool authority signs `register_endpoint` for all 5 slugs.

### Task 4.4: Deploy Cloud Run services with mainnet env

- [ ] **Step 1:** Update each deploy script's env to point at mainnet RPC (Helius mainnet) + mainnet PROGRAM_ID + mainnet Secret Manager refs.
- [ ] **Step 2:** Deploy proxy, settler, indexer.
- [ ] **Step 3:** Deploy dashboard with `NEXT_PUBLIC_PROGRAM_ID=<mainnet>`, `NEXT_PUBLIC_SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...`. Remove "Get devnet USDC" button.
- [ ] **Step 4:** Smoke test mainnet with one of Rick/Alan's wallets and $5 USDC.

### Task 4.5: $200 pool seed

- [ ] **Step 1:** Pool authority sends 200 mainnet USDC to its ATA.
- [ ] **Step 2:** `top_up_coverage_pool(200_000_000)` on mainnet.

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
- `EndpointConfig` field names consistent across 1A.4 (Rust state) and 1B.3 (TS Endpoint registry types — note camelCase vs snake_case is per-language but field semantics match).
- `SettlementEvent` byte layout in 1A.16 matches what proxy emits in 1B.7 (both use `call_id, agent_wallet, endpoint_slug, premium_lamports, refund_lamports, latency_ms, breach, timestamp`).
- `claim_refund` instruction signature consistent: 1A.17 (Rust) vs 1E.4 (TS Codama call) vs 3.4 step 7 (CLI command).

**Note on AgentWallet LEN drift:** Task 1A.17 adds `total_refunds_claimed: u64` to AgentWallet. Update Task 1A.4 LEN comment to include this field. Consumers (1B, 1C, 1E) do not need to change since Codama regenerates from the source.
