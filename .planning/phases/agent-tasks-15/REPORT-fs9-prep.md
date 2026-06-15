# FS9 Devnet Redeploy — PREP REPORT (agent-tasks#15)

**Branch:** `fix/fs9-devnet-declare-id-15` (base `origin/develop` @ `cb8d475`)
**Scope:** SAFE PREP ONLY. No `solana program deploy`, no funding, no E2E executed.
Legacy Anchor crate (`packages/program/programs/pact-insurance`) untouched.

---

## 1. Problem (FS9 / blocker B1)

The live devnet deploy `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` was built from a
binary whose `declare_id!` was the **mainnet** id `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`.
Because `crate::ID` drives PDA derivation (`derive_*`) and the `create_account` owner,
the PDAs Solana derives at runtime do not match the deploy address, so `settle_batch`
reverts `ProgramError::InvalidSeeds` on devnet — no refund can settle. Reads/account
decode still pass, which is why liveness probes were green but the settlement path was
unreachable.

**Fix shape (prep):** a build-time cargo feature that swaps the `declare_id!` literal to
the devnet program id, so a devnet redeploy uses a binary whose `declare_id!` == its
deploy address. The DEFAULT build stays mainnet — never regress the canonical artifact.

---

## 2. Diff summary (5 files, +63/-3)

| File | Change |
|------|--------|
| `packages/program/.../pact-network-v1-pinocchio/src/lib.rs` | `declare_id!` is now cfg-gated: `#[cfg(not(feature="devnet-id"))]` → mainnet `5bCJ…`; `#[cfg(feature="devnet-id")]` → devnet `5jBQ…`. |
| `packages/program/.../pact-network-v1-pinocchio/Cargo.toml` | Added `devnet-id = []` to `[features]` (off by default). |
| `packages/protocol-v1-client/src/constants.ts` | Added `resolveDevnetProgramId()` — returns the validated `PACT_DEVNET_PROGRAM_ID` pubkey or `null` (browser-safe via `typeof process` guard). `PROGRAM_ID_DEVNET` literal unchanged. |
| `packages/sdk/src/network.ts` | devnet `programId` now `resolveDevnetProgramId()?.toBase58() ?? null` (was hardcoded `null`). Mainnet/localnet unchanged. |
| `packages/sdk/src/__tests__/network.test.ts` | Added env-override test (locks devnet picks up `PACT_DEVNET_PROGRAM_ID`); existing null-default test still green. |

**No mainnet values changed.** `PROGRAM_ID` (`5bCJ…`), `USDC_MINT_MAINNET`, and the
default `cargo build-sbf` output all stay mainnet.

---

## 3. Build + verify BOTH declared IDs (DONE)

Verification method: decode each base58 id to its 32 raw bytes and search the built
`.so` for those bytes (`declare_id!` embeds the pubkey bytes; `crate::ID` is used in
PDA derivation + `create_account`).

| Build command | declared id in `.so` | mainnet bytes | devnet bytes | result |
|---------------|----------------------|---------------|--------------|--------|
| `cargo build-sbf --features bpf-entrypoint` (default) | **5bCJ…** (mainnet) | present | absent | ✅ PASS |
| `cargo build-sbf --features bpf-entrypoint,devnet-id` | **5jBQ…** (devnet) | absent | present | ✅ PASS |

- Artifact: `packages/program/target/deploy/pact_network_v1.so`, **89,560 bytes (~87 KB)**.
- After verification the default (mainnet) artifact was rebuilt and left in place.

TS verification:
- `@q3labs/pact-protocol-v1-client` — 89 tests pass.
- `@q3labs/pact-sdk` `network.test.ts` — 7 tests pass (incl. new env-override case).

---

## 4. SOL-01 check (PR #245 merged) — CONFIRMED PRESENT

`settle_batch` settlement-authority forgeability fix is in the deployed source path:

- `src/instructions/settle_batch.rs:118-138` — calls `verify_settlement_authority(settlement_auth)?`
  BEFORE reading `sa.signer` / `sa.bump`, then enforces `sa.signer == settler_signer`.
- `src/pda.rs:91-100` — `verify_settlement_authority` performs BOTH:
  1. **derive check:** `account.address() == derive_settlement_authority()` (canonical PDA), and
  2. **owner check:** `account.owned_by(&ID)`.
  Returns `PactError::InvalidSettlementAuthority` (6033) otherwise.
- Merge provenance: `876187f test(protocol-v1-client): add 6033 InvalidSettlementAuthority
  to expected error codes (#245) (#263)`.

**Verdict:** SOL-01 guard present and complete. No flag. The devnet-id binary built in §3
includes this guard (same source).

---

## 5. Runbook — devnet redeploy (NO COMMANDS EXECUTED)

> STOPPED before deploy. The steps below are the exact sequence for Tu/Rick to run
> once a deploy location is chosen. Keys live in TWO places — pick one:
> **dev-vm-2** `~/pact-devnet-keys` OR **local** `~/.config/pact/devnet-keys`.

### 5a. Build the devnet-id binary
```bash
cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint,devnet-id
# → packages/program/target/deploy/pact_network_v1.so  (declare_id == 5jBQ…)
```
Confirm before deploying:
```bash
# 32 raw bytes of 5jBQ… must be present, 5bCJ… absent (see §3 method)
```

### 5b. Deploy / upgrade the live devnet program (5jBQ)
Upgrade authority is the devnet hot key `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS`.
```bash
KEYS=~/pact-devnet-keys            # dev-vm-2   (OR ~/.config/pact/devnet-keys local)
solana --url https://api.devnet.solana.com program deploy \
  --program-id   "$KEYS/pact-network-v1-program-keypair.json"  \
  --upgrade-authority "$KEYS/pact-devnet-upgrade-authority.json" \
  --keypair      "$KEYS/pact-devnet-upgrade-authority.json" \
  packages/program/target/deploy/pact_network_v1.so
# program-id keypair pubkey MUST == 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5
# upgrade-authority pubkey   MUST == 47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS
```

### 5c. Probe (read-only) — liveness + authority gate
```bash
cd scripts/devnet
pnpm --filter @pact-network/scripts-devnet exec tsx verify-network.ts probe \
  --program-id 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 \
  --rpc https://api.devnet.solana.com \
  --expect-authority 47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS --json
```

### 5d. init-devnet (only if ProtocolConfig / SettlementAuthority / Treasury missing)
```bash
PACT_DEVNET_PROGRAM_ID=5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 \
  pnpm --filter @pact-network/scripts-devnet exec tsx init-devnet.ts
```
(Note: after a same-id upgrade the existing PDAs persist; init is only for a fresh
program id. Re-run `probe` to confirm.)

### 5e. Seed dummy pool vault (>= 1 USDC) + fund/approve agent ATA
Devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, mint authority `GrNg1XM2…`.
```bash
spl-token mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU 1 \
  --recipient <dummy poolVault> --url devnet      # refund source, >= 1_000_000 base units
pnpm --filter @pact-network/scripts-devnet run fund-agent   # mints USDC to agent ATA + SPL approve to SettlementAuthority delegate
```

### 5f. Strict E2E with the two false-pass guards
```bash
scripts/devnet/local-strict-e2e.sh up
```
Drives: dummy-upstream → market-proxy → Redis → settler (real `settle_batch` on devnet)
→ indexer → SDK `refund` event. The breach is induced via the upstream `?fail=1` →
`503` path.

**Guard 1 — golden-rule degrade (false-pass surface).** A miswired/stale proxy or a
silently-degraded covered call must NOT count as a pass: the harness frees fixed ports
8798/8799/3001/8080 pre-flight and asserts the breach actually produced an upstream
`503` (`?fail=1`) before settling — a "successful" call can never green a refund test.

**Guard 2 — depleted-pool false refund (Critical-1, Step [10] `assert-refund`).** The
settler pushes the *intended* refund to the indexer, NOT the on-chain actual — a depleted
pool settles "successfully" with 0 USDC moved yet the indexer still reports
`refundLamports>0`, so the SDK strict vitest green-passes falsely. Step [10] is the real
proof:
```bash
pnpm --filter @pact-network/scripts-devnet exec tsx verify-network.ts assert-refund \
  --program-id 5jBQ… --rpc <devnet> --call-id <id> --agent <pubkey> --ata-pre <lamports> --min-refund 1
```
Asserts on-chain `CallRecord.settlementStatus == Settled` **AND**
`actual_refund_lamports > 0` **AND** agent USDC ATA delta == `actualRefund - premium`.
PASS requires BOTH the SDK rc==0 AND assert-refund rc==0.

---

## 6. PR

- PR URL: **https://github.com/pactnetwork/pact-monitor/pull/269** (base `develop`, NOT merged).
- Branch: `fix/fs9-devnet-declare-id-15` @ commit `93d18eb`.

---

## 7. STOP

**STOPPED before deploy — needs Tu go + deploy-location (dev-vm-2 `~/pact-devnet-keys`
vs local `~/.config/pact/devnet-keys`).** No on-chain tx, no funding, no E2E run by this
crew. Code + build verification + runbook only.
