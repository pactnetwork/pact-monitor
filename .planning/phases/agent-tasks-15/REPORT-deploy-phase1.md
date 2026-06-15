# FS9 Deploy — Phase 1 (Build + Pre-Flight) Report

- **Task:** agent-tasks#15 — rebuild devnet v1 program with correct `declare_id`, pre-flight the devnet redeploy.
- **Branch:** `fs9-deploy-15` (tracking `origin/fix/fs9-devnet-declare-id-15`, HEAD `93d18eb`)
- **Date:** 2026-06-15
- **Scope:** BUILD + PRE-FLIGHT ONLY. No deploy, no fund, no e2e. Legacy Anchor crate untouched.

---

## A) Build + declared-id verification

Build command:

```
cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint,devnet-id
```

Result: `Finished release profile` — clean compile.

Artifact: `packages/program/target/deploy/pact_network_v1.so`

| Field | Value |
|-------|-------|
| Size | **89,560 bytes** |
| MD5  | **`673757926a4ca5a1d55f2e68923efe0d`** |

Declared-id byte verification (base58 → 32 raw bytes, searched in `.so`):

| Program ID | Raw bytes (hex) | Present in `.so`? |
|------------|-----------------|-------------------|
| Devnet `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` | `463ce89827e3d6995fdf7be53c7e07901575d38e4f13107d9191d8f271533f76` | **YES ✅** |
| Mainnet `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` | `443146be6181bd1201fdf91ffefabf1ec63882267b448c11e5e8d59f71f3251b` | **ABSENT ✅** |

Source wiring (`src/lib.rs:34-37`): default build emits mainnet `5bCJ…`; `--features devnet-id`
emits devnet `5jBQ…`. The built binary correctly carries the devnet id and NOT the mainnet id.

**PASS** — binary is devnet-correct and mainnet-safe.

---

## B) Key pubkeys (pubkey-only, no secret material handled)

| Role | Keypair file | Pubkey | Expected | Match |
|------|--------------|--------|----------|-------|
| Program ID | `~/.config/pact/devnet-keys/pact-network-v1-program-keypair.json` | `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` | `5jBQ…` | ✅ |
| Upgrade authority | `~/.config/pact/devnet-keys/pact-devnet-upgrade-authority.json` | `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` | `47Fg…` | ✅ |

---

## C) Pre-deploy snapshot + probe (read-only)

`solana --url https://api.devnet.solana.com program show 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`:

| Field | Value |
|-------|-------|
| Program Id | `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` |
| Owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| ProgramData Address | `2YETBtKq1DnxCVEHwKRmTjmesq6pA84Q8TBquqeHEapy` |
| Authority | `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` |
| Last Deployed In Slot | `460315243` |
| Data Length | `86,424` bytes (program); programdata account total = `86,469` bytes |
| Balance (programdata) | `0.60271512 SOL` |

`verify-network.ts probe` (program-id `5jBQ…`, expect-authority `47Fg…`, devnet RPC): exit `0`,
`"pass": true`, `"failures": []`.

- `b1.pass=true`, `protocolConfigPda=EFzSjDnAeb4yRA2LjXxmFmdyavdsEmsUNNDkxytvPdHU` (exists, `paused=0`),
  `settlementSigner=47Fg…`, `usdcMintMatchesDevnet=true`.
- Treasury initialized; vault `3k4Uii…` balance `200`.
- Endpoints `dummy` (pool 1,001,800) and `helius` (pool 0) both exist, not paused.

### FS9 symptom note (declare_id-mismatch)

The probe did **NOT** surface a `declare_id`-mismatch error — it passes cleanly. This is expected
and not a contradiction: `verify-network.ts` derives all PDAs **client-side from the program-id seed
base (`5jBQ…`)**, so its reads resolve regardless of what `declare_id!` the on-chain binary was
compiled with. The FS9 mismatch is internal to the deployed binary's `crate::ID` (compiled as the
mainnet `5bCJ…`) and only manifests **inside instruction handlers that derive/verify PDAs against
`crate::ID`** (e.g. `settle_batch` → `InvalidSeeds`). It is therefore not observable from a read-only
client probe. Phase 2 (the redeploy of this devnet-id binary) is what closes the gap; Phase-2 e2e
(`settle_batch`) is the correct place to confirm the symptom is gone.

---

## D) EXACT deploy command (DO NOT RUN — Phase 2)

```
solana --url https://api.devnet.solana.com program deploy \
  --program-id ~/.config/pact/devnet-keys/pact-network-v1-program-keypair.json \
  --upgrade-authority ~/.config/pact/devnet-keys/pact-devnet-upgrade-authority.json \
  --keypair ~/.config/pact/devnet-keys/pact-devnet-upgrade-authority.json \
  packages/program/target/deploy/pact_network_v1.so
```

Run from repo root `/Users/q3labsadmin/Q3/Solder/pact-network/.worktrees/pact-network-fs9-deploy`
(or substitute the absolute `.so` path). `--keypair` is fee payer + signs as upgrade authority; both
roles are `47Fg…`.

---

## E) SOL cost estimate + authority balance

- **Upgrade-authority `47Fg…` balance: `2.018692566 SOL`** (devnet) — sufficient.
- CLI: `solana-cli 3.1.13 (Agave)` — **auto-extends** the programdata account during `program deploy`
  upgrade when the new binary is larger (no manual `solana program extend` required).

Size growth: new `.so` (89,560 B) > current programdata capacity (86,469 B) → **+3,136 bytes**, so the
programdata account is extended on upgrade.

| Cost item | Amount | Refundable? |
|-----------|--------|-------------|
| Transient deploy buffer (rent-exempt, ~89,605 B) | ~`0.6245 SOL` | Refunded to payer after successful upgrade |
| Programdata account extend (+3,136 B permanent rent) | ~`0.02182656 SOL` | No (permanent) |
| Chunked write + finalize tx fees (~90 txs) | ~`0.0005 SOL` | No |
| **Net permanent cost** | **~`0.0223 SOL`** | — |
| **Peak transient balance needed during deploy** | **~`0.65 SOL`** | — |

Authority balance `2.018 SOL` comfortably covers the ~0.65 SOL transient peak and the ~0.0223 SOL net.

---

## F) Status

**READY TO DEPLOY — awaiting Tu go. NOT executed.**

No deploy, fund, or e2e was run. Legacy Anchor crate untouched. Build + all pre-flight checks green.
