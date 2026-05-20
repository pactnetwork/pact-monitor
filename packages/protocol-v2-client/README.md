# @q3labs/pact-protocol-v2-client

TypeScript client for the V2 Pinocchio program
(`packages/program/programs-pinocchio/pact-network-v2-pinocchio/`).

> **V2 is parametric/oracle insurance.** Most state-changing instructions
> are oracle- or `ProtocolConfig.authority`-signed. The per-pool
> `pool.authority` field is stored but **never checked by any V2 handler**
> — this package does not expose any "as pool authority" capability because
> none exists on chain.

## Status

V2 is **not yet deployed** at the time of this package's first publish.
The on-chain program lives at
`packages/program/programs-pinocchio/pact-network-v2-pinocchio/` with
`declare_id!("7i9zJMwaTRw4Tdy7SAfXJdDkYQD39xyKmkBhWuUSgDJU")`. This client
is verified against the program's Rust unit-test fixtures (PDA fixtures in
`pda.rs::tests::pinned_fixture_*`); there are no LiteSVM tests for V2 yet,
and no devnet/mainnet deploys. Once V2 deploys, the `PROGRAM_ID` constant
in `src/constants.ts` is the single source of truth and a follow-up bump
is a one-line PR.

## V1 vs V2

This package is **independent** of `@q3labs/pact-protocol-v1-client`:
different program, different PDAs, different state types, different error
codes. Do not import from V1 — the error codespaces share a base
(`6000`) but the *names* diverge (V2: `ProtocolPaused = 6000`,
V1: `InsufficientBalance = 6000`).

## Authority model

| Instruction | Signer | Notes |
| --- | --- | --- |
| `initialize_protocol` | `DEPLOYER_PUBKEY` (C-01) | Cold-boot only; hardcoded on chain. |
| `update_config` | `ProtocolConfig.authority` | Treasury + USDC mint frozen. |
| `update_oracle` | `ProtocolConfig.authority` | Rejects oracle == authority (C-02). |
| `create_pool` | `ProtocolConfig.authority` | Enforces pool_usdc_mint == config.usdc_mint. |
| `deposit` | Underwriter | User-signed; resets cooldown. |
| `enable_insurance` | Agent | Snapshots referrer at creation (WP-12). |
| `disable_policy` | Agent | Sets `policy.active = 0`. |
| `settle_premium` | `ProtocolConfig.oracle` (C-02) | 3-way split: pool, treasury, referrer. |
| `withdraw` | Underwriter | Cooldown-gated. |
| `update_rates` | `ProtocolConfig.oracle` (C-02) | Per-pool rate update. |
| `submit_claim` | `ProtocolConfig.oracle` (C-02) | Aggregate cap enforcement + window reset. |

## Multisig

V2 will rotate `ProtocolConfig.authority` to a Squads multisig before
mainnet (per CLAUDE.md "Authority rotation before mainnet"). This client
takes `PublicKey` for all signer params, NOT `Keypair` — caller wraps the
returned `TransactionInstruction` via `@sqds/multisig`
`vaultTransactionCreate` → `proposalCreate` → `proposalApprove` × N →
`vaultTransactionExecute` when the authority is a multisig.

## What's in this package

- `PROGRAM_ID`, USDC mint constants, seed bytes, discriminator bytes, default
  config values — all in `src/constants.ts`.
- PDA helpers `getProtocolConfigPda`, `getCoveragePoolPda`, `getVaultPda`,
  `getUnderwriterPositionPda`, `getPolicyPda`, `getClaimPda` —
  `src/pda.ts`.
- (C2) State decoders for `ProtocolConfig` / `CoveragePool` /
  `UnderwriterPosition` / `Policy` / `Claim` — `src/state.ts`.
- (C3) Instruction builders for all 11 V2 instructions — `src/instructions.ts`.
- (C4) Reads + helpers (`getAgentPolicyState`, `getPoolState`, `hashCallId`,
  `deriveAssociatedTokenAccount`) — `src/helpers.ts`.
- Error map: `src/errors.ts`.

## Why no Codama / IDL

Pinocchio emits no IDL; Shank expects Borsh state and `#[derive(ShankAccount)]`
annotations — incompatible with V2's `repr(C) + bytemuck::Pod` accounts.
Codama can be hand-authored without an IDL but produces code less ergonomic
than this hand-rolled client for a 6-account / 11-instruction program. Do
not migrate to Codama for marginal gain.
