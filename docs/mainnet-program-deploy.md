# Pact Network V1 — Mainnet Program Deploy

Operator runbook for deploying the V1 on-chain program (`pact_network_v1.so`) to Solana mainnet from Rick's laptop.

**Audience:** the person holding the upgrade-authority keypair (Rick).

**Scope:** ON-CHAIN program only. The off-chain Cloud Run stack is covered separately in `mainnet-cloud-run-deploy.md`. Protocol initialization (8 init txs after deploy) is covered in `scripts/mainnet/README.md`.

---

## 0. What you're deploying

A single Pinocchio 0.10 SBF binary built from `packages/program/programs-pinocchio/pact-network-v1-pinocchio/`. ~88,680 bytes. Compiled-in program ID `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`.

| Property | Value |
|---|---|
| Program ID (declared) | `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` |
| Upgrade authority | `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL` (laptop hot key — rotate to Squads multisig within 2-4 weeks) |
| Binary size | ~88 KB |
| Build flag | `cargo build-sbf --features bpf-entrypoint` |
| Network | Solana mainnet-beta |
| SOL needed | ~1.5 SOL on the upgrade-authority pubkey |

The binary contains 16 instructions: `initialize_protocol_config`, `initialize_treasury`, `initialize_settlement_authority`, `register_endpoint`, `pause_endpoint`, `top_up_coverage_pool`, `update_endpoint_config`, `update_fee_recipients`, `settle_batch`, `pause_protocol`, plus internals.

The kill switch (`pause_protocol`, discriminator 15) sets `ProtocolConfig.paused = 1`, causing every `settle_batch` to reject with error `6032 (ProtocolPaused)` until unpaused. Use `scripts/mainnet/pause-protocol.ts` to toggle.

---

## 1. Prerequisites (one-time on your laptop)

### 1.1 Tools

```bash
solana --version       # 3.1.x or later
rustc --version        # 1.92.x via rustup
cargo build-sbf --version   # comes with solana CLI

# If missing:
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 1.2 Keypair files

Required at `~/pact-mainnet-keys/`:

```
pact-network-v1-program-keypair.json     pubkey: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
pact-mainnet-upgrade-authority.json      pubkey: JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL
```

If you don't have these — STOP. They are the canonical mainnet keys; do not generate replacements without explicit team alignment. The seed phrases must already be backed up offline. If they are not, restart the keypair workflow per `scripts/mainnet/README.md` Phase 1 BEFORE proceeding.

Verify perms:

```bash
ls -la ~/pact-mainnet-keys/
# expect: dir 700, files 600
```

### 1.3 Funding

The upgrade-authority pubkey needs **≥1.5 SOL mainnet** before the deploy step.

```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/pact-mainnet-keys/pact-mainnet-upgrade-authority.json
solana balance
# expect: 1.5+ SOL
```

Estimated spend:
- Program rent (88 KB × ~0.0072 SOL/KB exempt rate × 2 for Loader v3 buffer): ~0.6 SOL
- Per-tx fees during deploy: ~0.005 SOL
- Init txs (8 of them, after deploy): ~0.05 SOL
- Buffer cushion: 0.5 SOL
- **Total: ~1.2 SOL conservatively, 1.5 SOL safe**

If the deploy fails partway with "Account allocation failed" you'll need ~0.5 SOL more — top up and retry. Solana CLI auto-resumes from the buffer.

---

## 2. Build the SBF binary

You can build on your laptop OR scp the artifact from the dev VM. Building on the laptop is **recommended** so the binary you deploy is the binary you've inspected.

### 2.1 Build on laptop (recommended)

```bash
git clone https://github.com/pactnetwork/pact-monitor.git
cd pact-monitor
git checkout develop   # or whichever release tag
git pull

cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint
```

**Critical:** `--features bpf-entrypoint` is REQUIRED. Without it, cargo produces a stub binary (~3 KB instead of ~88 KB) that has no entrypoint. The deploy will succeed but no instruction will work. Easy to miss; double-check the binary size:

```bash
ls -la ../../target/deploy/pact_network_v1.so
# expect: 88,680 bytes (or thereabouts — close to 88 KB)
```

If you see ~3 KB, you forgot the feature flag. Rebuild.

### 2.2 Build on dev VM, scp to laptop (alternative)

```bash
# on dev VM
cd /path/to/pact-monitor/packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint
ls -la ../../target/deploy/pact_network_v1.so

# on laptop
scp dev-vm:/path/to/pact-monitor/packages/program/target/deploy/pact_network_v1.so ~/Downloads/
```

### 2.3 Sanity-check the embedded program ID

The binary should have the mainnet program ID compiled in via `declare_id!()` on `lib.rs:21`. Verify by looking at the source you built from:

```bash
grep "declare_id" packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/lib.rs
# expect: solana_address::declare_id!("5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc");
```

If it says anything else (e.g. the old devnet `5jBQb7fL...`), you're on the wrong branch. Check out `develop` post-PR-#71 or any release tag from May 6 2026 onward.

---

## 3. Deploy

This is the moment of no return — it spends real SOL and creates an on-chain program account at the canonical pubkey.

```bash
# Confirm context first
solana config get
# expect:
#   RPC URL: https://api.mainnet-beta.solana.com
#   Keypair Path: /Users/rick/pact-mainnet-keys/pact-mainnet-upgrade-authority.json
solana balance
# expect: 1.5+ SOL

# Deploy
solana program deploy \
  --program-id ~/pact-mainnet-keys/pact-network-v1-program-keypair.json \
  ~/Downloads/pact_network_v1.so \
  --max-len 1048576
```

### 3.1 What `--max-len 1048576` does

Allocates 1 MB for the program account regardless of current binary size. This lets you upgrade to a larger binary later without re-deploying at a new address. 1 MB is the standard ceiling — covers any realistic future binary growth.

### 3.2 Watch for the success line

```
Program Id: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
Signature: <DEPLOY_SIG>
```

**Save the deploy signature.** Paste it to your team chat / state file for the record. View it on Solana Explorer:

```
https://explorer.solana.com/tx/<DEPLOY_SIG>
```

### 3.3 If it fails

| Error | Cause | Fix |
|---|---|---|
| `Account allocation failed` | Out of SOL during the multi-tx deploy. | Send 0.5 SOL more to upgrade-authority pubkey. Retry the same `solana program deploy` command — Solana CLI resumes from the on-chain buffer it created. |
| `Custom program error: 0x1` | Program ID keypair doesn't match the `declare_id!` baked in the binary. | Verify §2.3. If mismatch, you used the wrong keypair OR built from the wrong branch. Don't proceed. |
| `429 Too Many Requests` | Mainnet RPC rate-limited the upload. | Set `solana config set --url <helius_mainnet_url>` and retry. Or wait 30s. |
| `RPC connection refused` | api.mainnet-beta.solana.com is having a moment. | Same as above — switch to Helius. |
| Hangs forever after upload | Buffer was uploaded but the swap-into-program tx didn't land. | Ctrl+C, then `solana program deploy --buffer <buffer_pubkey>` to resume from the buffer Solana shows in the failure output. |

---

## 4. Verify

```bash
solana program show 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
```

Expect output similar to:

```
Program Id: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
Owner: BPFLoaderUpgradeable11111111111111111111111
ProgramData Address: <some_pda>
Authority: JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL
Last Deployed In Slot: <slot>
Data Length: 88680 (0x15a68) bytes
```

Critical fields to confirm:
- **Authority**: must be `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL` (your upgrade-authority pubkey). If anything else, the deploy was misconfigured — STOP and investigate before any init.
- **Data Length**: ~88,680 bytes. If 3 KB or similar, you deployed the stub binary (forgot `--features bpf-entrypoint`). Re-deploy via `solana program deploy ...` against the same program-ID; Solana will overwrite the binary at the same address.
- **Owner**: `BPFLoaderUpgradeable11111111111111111111111` — the upgradeable loader. Anything else means you used a non-upgradeable deploy variant; should not happen with the command above.

Also verify on Solana Explorer:

```
https://explorer.solana.com/address/5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
```

Should show "Verified" at some point after Solscan / OtterSec / etc. process — not required for launch but nice.

---

## 5. Next: protocol initialization

The program is deployed but the protocol is not yet initialized. No `ProtocolConfig`, no `Treasury`, no endpoints registered.

Proceed to `scripts/mainnet/README.md` Phase 3+ for the 8 init transactions:
1. `initialize_protocol_config`
2. `initialize_treasury`
3. `initialize_settlement_authority`
4-8. `register_endpoint` × 5 (helius, birdeye, jupiter, elfa, fal)

Do NOT skip the `DRY_RUN=1` rehearsal in that runbook before sending real init txs.

---

## 6. Upgrades (later, when fixes ship)

When a future bug fix or feature is ready and merged into `develop`, redeploy the binary at the SAME program ID:

```bash
# Build the new binary (same flow as §2.1)
cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
git pull
cargo build-sbf --features bpf-entrypoint

# Deploy the new binary at the existing program ID
solana program deploy \
  --program-id ~/pact-mainnet-keys/pact-network-v1-program-keypair.json \
  ../../target/deploy/pact_network_v1.so
```

(No `--max-len` needed on upgrade — the program account already has the 1 MB allocation from initial deploy.)

The upgrade is atomic from the user's perspective: the next slot after the deploy tx confirms uses the new binary. There's no downtime, but there's a 1-2 slot window where in-flight `settle_batch` txs could land against the old binary OR the new one. If the upgrade changes account layouts in a non-backwards-compatible way, **pause the protocol first** (§7) to drain in-flight txs, then upgrade, then unpause.

### 6.1 Compatibility rules for upgrades

Safe (no pause needed):
- Add new instructions with new discriminators (see `discriminator.rs`)
- Add new fields at the END of an existing account struct (after the last `pub` field, before any `_padding` arrays — verify with `assert!(...::LEN == ...)`)
- Tighten validation (reject calls that the old code accepted)

NOT safe without pause:
- Reorder existing fields in any account struct
- Change the meaning of existing bytes (e.g. repurposing a `_padding` byte without coordinating decoder updates first)
- Remove or rename a discriminator
- Change the instruction account list ordering for any existing instruction

If unsure, pause. Better to lose 5 minutes of throughput than to corrupt PoolState reconciliation.

---

## 7. Kill switch (`pause_protocol`)

If a critical bug surfaces post-deploy, pause IMMEDIATELY before any more `settle_batch` txs land.

```bash
cd /path/to/pact-monitor/scripts/mainnet
bun install   # first time only
bun run pause -- --paused 1   # PAUSE
```

The script:
1. Reads current `ProtocolConfig.paused` byte (75)
2. No-ops if already at target state
3. Sends `pause_protocol(paused=1)` ix signed by upgrade-authority
4. Verifies post-tx state matches target
5. Prints final state + tx signature

While paused:
- Every `settle_batch` rejects with on-chain error `0x1790` (6032 — `PactError::ProtocolPaused`)
- Settler logs the error, nacks the message; Pub/Sub redelivers; settler keeps trying
- Pub/Sub queue grows but messages don't drop until the DLQ depth threshold (10 redeliveries)
- Agents can still call `wrap → market-proxy → upstream`; they're charged a premium on the agent's ATA (via the Approval delegate) but the on-chain settlement is blocked

Unpause after fix:

```bash
bun run pause -- --paused 0
```

Settler retries cycle through and start landing again.

### 7.1 Dry-run rehearsal

Always rehearse before a real pause:

```bash
DRY_RUN=1 bun run pause -- --paused 1
```

The script will print what it would do without sending a tx. Verifies the keypair is loadable, the program is reachable, and the current state.

---

## 8. Authority rotation to multisig (post-launch)

Within 2-4 weeks of launch, rotate the upgrade authority from your laptop hot key to a Squads multisig. Plan:

1. Pre-stage a Squads multisig BEFORE you ever need to rotate. Members: yourself + 2-3 trusted operators.
2. Capture the multisig's authority pubkey.
3. Run:

```bash
solana program set-upgrade-authority \
  5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc \
  --new-upgrade-authority <SQUADS_AUTHORITY_PUBKEY> \
  --keypair ~/pact-mainnet-keys/pact-mainnet-upgrade-authority.json
```

After this point:
- Future upgrades require Squads multisig approval (not your laptop alone)
- Future `pause_protocol` calls also require multisig — but this gates incident response. **Add a permissioned hot-key admin path to the on-chain program before rotating** so emergency pauses don't need a 3-of-N signature dance during a live incident.

The hot-key admin path doesn't exist in the current binary. Either add it before rotation, OR keep the upgrade authority on hot wallet for V1 and accept the multisig deferral.

### 8.1 Final option: revoke upgrade authority entirely

After V1 is battle-tested for 6+ months and major changes feel unlikely, revoke the upgrade authority entirely:

```bash
solana program set-upgrade-authority \
  5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc \
  --final \
  --keypair <CURRENT_AUTHORITY_KEYPAIR>
```

After this, the program is IMMUTABLE forever. Pace yourself — there's no going back.

---

## 9. Pre-launch checklist

Run through before clicking deploy:

- [ ] Solana CLI 3.1.x installed
- [ ] cargo-build-sbf works (`cargo build-sbf --version`)
- [ ] `~/pact-mainnet-keys/` exists with 700 perms
- [ ] Both keypair files at 600 perms
- [ ] Seed phrases backed up offline (paper or password manager — NOT cloud sync)
- [ ] FileVault / disk encryption ON for the laptop
- [ ] `solana config get` shows mainnet URL + upgrade-authority keypair
- [ ] `solana balance` ≥ 1.5 SOL
- [ ] Built binary is 88 KB (not 3 KB stub)
- [ ] `grep declare_id` shows mainnet pubkey, not devnet
- [ ] Squads multisig pre-staged (rotate-target captured) — can defer if launch is urgent
- [ ] `pause-protocol.ts` script tested via `DRY_RUN=1` against devnet first (optional but recommended)

When all checked, run §3.

---

## 10. Post-deploy checklist

- [ ] `solana program show <PROGRAM_ID>` confirms Authority + Data Length
- [ ] Solana Explorer link works
- [ ] Deploy signature saved to team chat
- [ ] Move to `scripts/mainnet/README.md` Phase 3+ for protocol init
- [ ] Inform devops agent (Cloud Run deploy can now start — settler needs the program live to test against)

---

## 11. Rollback

There is no "rollback" for a deployed Solana program — the on-chain state persists. Options if something is fundamentally broken:

1. **Pause + upgrade**: `pause-protocol --paused 1`, deploy fixed binary at same program ID, `pause-protocol --paused 0`. Atomic from user perspective except for the in-flight settle_batch race window. Best option for fixable bugs.

2. **Pause + new program ID**: if the bug requires account-layout changes that aren't backwards-compatible, pause the broken program forever (don't unpause), deploy a fresh binary at a NEW program ID, re-init all PDAs there, swap off-chain config to the new ID. The orphaned program eats its rent (~0.6 SOL) but otherwise causes no harm.

3. **Revoke upgrade authority** (don't): only relevant if you're done with V1 forever. Doesn't fix anything live.

For non-bug-driven rollbacks (e.g. economic policy change), the same upgrade flow applies — bake the new policy into a binary, deploy via §6.

---

## 12. References

- Solana docs: <https://solana.com/docs/programs/deploying>
- Pinocchio: <https://github.com/anza-xyz/pinocchio>
- BPF Loader: <https://docs.solana.com/developing/runtime-facilities/programs#bpf-loader>
- This protocol's source of truth: `packages/program/programs-pinocchio/pact-network-v1-pinocchio/`
- Off-chain stack deploy: `mainnet-cloud-run-deploy.md`
- Protocol init: `scripts/mainnet/README.md`
- Kill switch script: `scripts/mainnet/pause-protocol.ts`
