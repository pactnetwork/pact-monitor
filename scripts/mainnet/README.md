# Pact Network V1 — Mainnet Init Runbook

Procedure for deploying the V1 program to mainnet and running protocol initialization. **Run from Rick's laptop.** The upgrade-authority keypair must NOT touch the dev VM.

## TL;DR

```bash
# Phase 1: laptop prep
mkdir -p ~/pact-mainnet-keys && chmod 700 ~/pact-mainnet-keys
solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-mainnet-keys/settlement-authority.json
solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-mainnet-keys/treasury-vault.json
for slug in helius birdeye jupiter elfa fal; do
  solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-mainnet-keys/pool-vault-$slug.json
done
chmod 600 ~/pact-mainnet-keys/*.json

# Phase 2: deploy program (~0.62 SOL rent — no --max-len, ProgramData fits binary)
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/pact-mainnet-keys/pact-mainnet-upgrade-authority.json
solana balance   # need ≥1 SOL
solana program deploy \
  --program-id ~/pact-mainnet-keys/pact-network-v1-program-keypair.json \
  ~/Downloads/pact_network_v1.so
# To grow the binary in a future upgrade:
#   solana program extend <PROG_ID> <ADDITIONAL_BYTES>  (pays marginal rent only)

# Phase 3: rehearsal init (no txs sent)
cd /path/to/pact-monitor/scripts/mainnet
bun install
DRY_RUN=1 bun init

# Phase 4: real init
bun init
```

## Required keypairs

All in `$MAINNET_KEYS_DIR` (default `~/pact-mainnet-keys`):

| File | Purpose | Owner |
|---|---|---|
| `pact-network-v1-program-keypair.json` | Program ID `5bCJcdWdK…` | You — protect at all costs |
| `pact-mainnet-upgrade-authority.json` | Protocol auth + Treasury auth + tx fee payer | You — protect at all costs (rotate to multisig in 2-4 weeks) |
| `settlement-authority.json` | Settler service hot signing key | Generate fresh — will be uploaded to GCP Secret Manager for the Cloud Run settler |
| `treasury-vault.json` | Treasury USDC vault account | Throwaway — only signs the init tx, then becomes the Treasury vault |
| `pool-vault-{slug}.json` × 5 | Per-endpoint pool USDC vault | Throwaway — same pattern as treasury-vault |

Generate the missing ones:

```bash
solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-mainnet-keys/settlement-authority.json
solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-mainnet-keys/treasury-vault.json
for slug in helius birdeye jupiter elfa fal; do
  solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-mainnet-keys/pool-vault-$slug.json
done
chmod 600 ~/pact-mainnet-keys/*.json
```

The seed phrases for `pact-mainnet-upgrade-authority.json` and `pact-network-v1-program-keypair.json` MUST be backed up offline (paper or password manager). Losing them = losing the protocol.

The settlement-authority and vault keypairs CAN be regenerated if needed (they only sign once each), but losing them post-init means losing access to those vaults — keep them too.

## Phase 1: Laptop prep

You should already have:
- ✅ `pact-network-v1-program-keypair.json` (pubkey `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`)
- ✅ `pact-mainnet-upgrade-authority.json` (pubkey `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL`)

You need to generate (commands above):
- ❌ `settlement-authority.json`
- ❌ `treasury-vault.json`
- ❌ `pool-vault-{helius,birdeye,jupiter,elfa,fal}.json`

Print all pubkeys for the record:

```bash
for f in ~/pact-mainnet-keys/*.json; do
  echo "$(basename $f): $(solana-keygen pubkey $f)"
done
```

Save this output — `init-mainnet.ts` will use these and the printout is your independent verification.

## Phase 2: Deploy program

You need ≥**1 SOL** on the upgrade-authority pubkey before this step. (~0.62 rent + ~0.05 init + buffer — no `--max-len` keeps it cheap.) If you've already funded it, verify:

```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/pact-mainnet-keys/pact-mainnet-upgrade-authority.json
solana balance
```

Get the SBF binary from the dev VM (it's built and in develop):

```bash
# from your laptop
scp dev-vm:/path/to/pact-monitor/packages/program/target/deploy/pact_network_v1.so ~/Downloads/

# or rebuild on your laptop:
git clone https://github.com/pactnetwork/pact-monitor.git
cd pact-monitor/packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint
# binary at ../../target/deploy/pact_network_v1.so
```

Verify the binary embeds the right program ID:

```bash
ls -l ~/Downloads/pact_network_v1.so   # expect 88,680 bytes
```

Deploy:

```bash
solana program deploy \
  --program-id ~/pact-mainnet-keys/pact-network-v1-program-keypair.json \
  ~/Downloads/pact_network_v1.so
```

> No `--max-len`. ProgramData is sized to the binary (~88KB), keeping rent at ~0.62 SOL. If a future binary is bigger than that, run `solana program extend <PROG_ID> <ADDITIONAL_BYTES>` once before the upgrade `deploy`.

Watch for:
```
Program Id: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
Signature: <DEPLOY_SIG>
```

Save the deploy signature.

If it errors with "Account allocation failed", you need more SOL (send another 0.5 SOL). The Solana CLI auto-resumes from the buffer.

Verify:

```bash
solana program show 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
# Authority should be JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL
```

## Phase 3: Rehearsal (DRY_RUN)

Walk through the init script without sending any transactions. This validates that all keypairs are present, the program is deployed, and the upgrade-authority has SOL.

```bash
cd /path/to/pact-monitor/scripts/mainnet
bun install
DRY_RUN=1 bun init
```

You should see ALL 8 steps complete with `DRY_RUN_*` placeholder signatures and a clean exit. If anything errors, fix it before proceeding.

## Phase 4: Review endpoint config

Open `endpoint-config.json` and confirm the values for each of the 5 endpoints are what you want:

- **flatPremiumLamports**: cost per call, in USDC base units (6 decimals). `1000` = $0.001.
- **percentBps**: percentage premium on top of flat. `0` = flat-only pricing.
- **slaLatencyMs**: SLA breach threshold. Calls slower than this get refunded.
- **imputedCostLamports**: refund amount when call fails.
- **exposureCapPerHourLamports**: max payout from this pool per rolling hour.
- **treasuryFeeBps** (top-level): default 1000 (10%) of every premium goes to Treasury.

Edit values, then re-run rehearsal.

## Phase 5: Real init

```bash
cd /path/to/pact-monitor/scripts/mainnet
bun init
```

This sends 8 transactions in order:

| # | Instruction | What |
|---|---|---|
| 1 | initialize_protocol_config | Singleton — sets authority + USDC mint + max_total_fee_bps cap |
| 2 | initialize_treasury | Singleton — creates Treasury PDA + USDC vault |
| 3 | initialize_settlement_authority | Registers the settler service's signing pubkey |
| 4 | register_endpoint("helius") | + creates CoveragePool PDA + pool USDC vault |
| 5 | register_endpoint("birdeye") | same |
| 6 | register_endpoint("jupiter") | same |
| 7 | register_endpoint("elfa") | same |
| 8 | register_endpoint("fal") | same |

Each step is one transaction. Signatures stream to stdout AND get written to `.mainnet-state.json`.

## Phase 6: Verify

The init script prints verification commands at the end. Run them:

```bash
solana program show <PROGRAM_ID>
solana account <PROTOCOL_CONFIG_PDA>
solana account <TREASURY_PDA>
solana account <SETTLEMENT_AUTHORITY_PDA>
# and 5 × CoveragePool PDAs
```

Each should return non-empty data.

## Phase 7: Pool seeding

After init, each `CoveragePool` exists but its USDC vault is empty. Send mainnet USDC to each pool vault from your treasury wallet:

```bash
# Pool vault addresses are in scripts/mainnet/.mainnet-state.json
# Use Phantom / spl-token transfer / or:
spl-token transfer <USDC_MINT> <AMOUNT> <POOL_VAULT_ADDR>
```

For private beta with capped pool, $200-1000 per endpoint is reasonable. Adjust per `exposureCapPerHourLamports` (default 10 USDC/hour).

## Phase 8: Settlement-authority keypair → Cloud Run secret

The `settlement-authority.json` keypair generated in Phase 1 is the settler service's signing key. It needs to live on the Cloud Run settler instance.

Upload to GCP Secret Manager:

```bash
gcloud secrets create pact-mainnet-settlement-authority --replication-policy="automatic"
gcloud secrets versions add pact-mainnet-settlement-authority --data-file=~/pact-mainnet-keys/settlement-authority.json
```

The Cloud Run deploy plan (separate doc) wires this secret into the settler container.

## Rollback

If init fails partway:

- After step 1 (protocol_config): re-run; the script is NOT idempotent. ProtocolConfig already exists. To recover, you'd need to call `update_protocol_config` (not yet supported) or accept current state.
- After step 2 (treasury): same — Treasury exists. Continue from step 3.
- After step 4+ (register_endpoint): each is independent; if one slug fails you can re-run with only that slug in `endpoint-config.json`.

If you want to nuke everything and start over: deploy a NEW program (different program ID) and re-init. The orphaned program at `5bCJcdWdK…` is irrecoverable but consumes only its rent (~3 SOL).

## Kill switch

If a critical bug surfaces post-launch, flip the on-chain `pause_protocol`
flag from your laptop. Sets `ProtocolConfig.paused`, which makes every
`settle_batch` reject with `PactError::ProtocolPaused (6032)` before any
per-event work runs. Existing SPL Token approvals on agent ATAs do NOT
auto-revoke, but no settlement can drain them while paused.

Script: [`scripts/mainnet/pause-protocol.ts`](pause-protocol.ts).

```bash
cd scripts/mainnet
bun install   # first run only

# Rehearse first — reads on-chain state, prints what would happen, no tx sent.
DRY_RUN=1 bun run pause -- --paused 1

# PAUSE the protocol (settlement halted globally).
bun run pause -- --paused 1

# UNPAUSE the protocol once the incident is resolved.
bun run pause -- --paused 0
```

What the script does:

1. Reads `pact-mainnet-upgrade-authority.json` and
   `pact-network-v1-program-keypair.json` from `$MAINNET_KEYS_DIR`
   (default `~/pact-mainnet-keys`). Program ID is derived from the keypair
   file — `.mainnet-state.json` is not required.
2. Connects to `$MAINNET_RPC_URL` (default
   `https://api.mainnet-beta.solana.com`) and confirms the program is deployed.
3. Fetches `ProtocolConfig`, decodes `paused` (byte 75) via
   `decodeProtocolConfig`, prints the current state.
4. Asserts the keypair pubkey matches `ProtocolConfig.authority` on chain —
   any mismatch aborts before sending.
5. **No-ops** with exit 0 if already at the requested state.
6. Builds `pause_protocol` (discriminator 15), signs with the upgrade
   authority, sends with `confirmed` commitment.
7. Refetches `ProtocolConfig` and asserts the new `paused` byte matches
   the requested target. If it doesn't, exits non-zero with the tx signature
   so you can investigate manually.

Operator-only. The dashboard ops UI will ship later for the same toggle, gated
to the same authority via `nacl` signed-message verification.

## Hand-off to dev VM after init

After `.mainnet-state.json` is written:

1. **Sanitize** — review for any sensitive data. The state file should contain only public addresses + tx signatures. No secrets.
2. **Commit** — `git add scripts/mainnet/.mainnet-state.json` if you want it in the repo for ops reference. **OR** keep it laptop-local.
3. **Pubkeys for dev VM** — share these with the dev VM (via Slack / Notion / etc):
   - settlement-authority pubkey
   - treasury PDA + vault
   - protocol_config PDA
   - 5 × CoveragePool PDAs + their vault addresses

The dev VM uses these pubkeys to configure Cloud Run env vars (settler, indexer, market-proxy). Pubkeys are not sensitive.
