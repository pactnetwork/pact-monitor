# Mainnet Launch Checklist — Rick's Sequence

Complete, self-contained checklist of everything **you** (Rick) need to do to take Pact Network V1 live on Solana mainnet. Each block is gated on the previous unless marked parallel-safe.

**Audience:** you. The operator with the keys, the SOL, and the GCP billing.

**Scope:** the human path. AI-handled artifacts (terraform module, GH workflows, init script, smoke harness, disclosure copy) are already in develop — you just trigger them.

---

## Block 0 — Already done (no action needed)

For context, these are the artifacts already on `develop` that you'll use:

| Artifact | Location |
|---|---|
| Mainnet program ID baked into binary | `lib.rs` declares `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` |
| SBF binary build command | `cargo build-sbf --features bpf-entrypoint` (88,680 bytes) |
| Init script for the 8 protocol-init txs | `scripts/mainnet/init-mainnet.ts` |
| Editable endpoint config (premium amounts) | `scripts/mainnet/endpoint-config.json` |
| Detailed program-deploy runbook | `docs/mainnet-program-deploy.md` |
| Detailed Cloud Run deploy doc | `docs/mainnet-cloud-run-deploy.md` |
| Pause-protocol kill switch script | `scripts/mainnet/pause-protocol.ts` |
| Mainnet 10-call smoke harness | `scripts/mainnet-smoke/` |
| Beta user disclosure copy | `docs/beta-user-disclosure.md` |
| Terraform module for prod GCP project | `~/devops/terraform-gcp/pact-network-prod/` (LOCAL on `feat/pact-network-prod-scaffold`, not yet pushed) |
| GH Actions workflows for build + deploy | `.github/workflows/build-pact-network.yaml`, `deploy-pact-network.yaml` (waiting for `project_number` fill-in) |

What you confirmed:
- Mainnet program-ID keypair: `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` at `~/pact-mainnet-keys/pact-network-v1-program-keypair.json`
- Mainnet upgrade-authority keypair: `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL` at `~/pact-mainnet-keys/pact-mainnet-upgrade-authority.json`
- Two RPCs: Alchemy (free credits) for Pact internals, Helius for the `helius` endpoint slug upstream

---

## Block 1 — Laptop prep (parallel with Block 2)

### 1.1 Generate 7 missing keypairs

These are throwaway-style — they only sign once during init. Generate fresh on your laptop:

```bash
mkdir -p ~/pact-mainnet-keys && chmod 700 ~/pact-mainnet-keys

# Settler service signing key (will be uploaded to Secret Manager later)
solana-keygen new --no-bip39-passphrase --silent \
  --outfile ~/pact-mainnet-keys/settlement-authority.json

# Treasury USDC vault account
solana-keygen new --no-bip39-passphrase --silent \
  --outfile ~/pact-mainnet-keys/treasury-vault.json

# Per-endpoint pool USDC vault accounts (5 of them)
for slug in helius birdeye jupiter elfa fal; do
  solana-keygen new --no-bip39-passphrase --silent \
    --outfile ~/pact-mainnet-keys/pool-vault-$slug.json
done

chmod 600 ~/pact-mainnet-keys/*.json

# Print all pubkeys for the record
for f in ~/pact-mainnet-keys/*.json; do
  echo "$(basename $f): $(solana-keygen pubkey $f)"
done
```

- [ ] Done

### 1.2 Back up seed phrases offline

The two critical keypairs (`pact-network-v1-program-keypair.json` and `pact-mainnet-upgrade-authority.json`) — paper or password manager. **Not iCloud / Drive / Dropbox / Git / email.** Lose these = lose the protocol forever.

The 7 throwaway keypairs from §1.1 — backup is nice but not critical (they only sign once during init).

- [ ] Done

### 1.3 Fund upgrade-authority with SOL

You need **≥1.5 SOL mainnet** at `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL` before deploy.

```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/pact-mainnet-keys/pact-mainnet-upgrade-authority.json
solana balance
```

Estimated burn: ~0.6 SOL program rent + ~0.05 SOL init txs + buffer.

- [ ] Done

### 1.4 Get RPC API keys

**Alchemy mainnet API key** (Pact's internal Solana RPC — settler tx submission, market-proxy chain reads, dashboard reads):
- Sign up at <https://www.alchemy.com/>
- Create a Solana mainnet app
- Copy the API key
- (Free credits cover beta volume comfortably)

**Helius mainnet API key** (upstream for the `helius` endpoint slug — proxies user RPC calls to Helius):
- Sign up at <https://www.helius.dev/>
- Get a mainnet API key (free tier OK for beta)

Don't paste the keys anywhere yet — they go into GCP Secret Manager in Block 4.

- [ ] Alchemy key obtained
- [ ] Helius key obtained

---

## Block 2 — GCP project (parallel with Block 1)

### 2.1 Create GCP project + link billing

```bash
gcloud projects create pact-network-prod --name="Pact Network Mainnet"
# If "pact-network-prod" is globally taken, fall back to "pact-net-prod" or similar
gcloud config set project pact-network-prod

# Link billing — replace ACCOUNT_ID with your billing account
gcloud beta billing accounts list
gcloud beta billing projects link pact-network-prod --billing-account=<ACCOUNT_ID>
```

- [ ] Project created
- [ ] Billing linked

### 2.2 Capture project_number

```bash
gcloud projects describe pact-network-prod --format='value(projectNumber)'
# Save this number — you'll paste it into 3 files below
```

- [ ] project_number captured: ____________________

### 2.3 Decide devops branch merge order

Your `~/devops` repo has two stacked feature branches:
- `feat/prism-prod-scaffold` (your in-flight prism project)
- `feat/pact-network-prod-scaffold` (stacked on top, the pact terraform module)

Pick:
- (a) Merge `feat/prism-prod-scaffold` → `main` first, then rebase pact branch onto main
- (b) Merge both as a stack (pact branch carries prism's commits with it)
- (c) Cherry-pick pact-network-prod off the prism dependency

- [ ] Decision: ____________________

---

## Block 3 — Smart contract deploy + protocol init (laptop, gated on Block 1)

Detailed runbook: `docs/mainnet-program-deploy.md` and `scripts/mainnet/README.md`.

### 3.1 Build the SBF binary on your laptop

```bash
git clone https://github.com/pactnetwork/pact-monitor.git
cd pact-monitor
git checkout develop
git pull

cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint

ls -la ../../target/deploy/pact_network_v1.so
# expect: 88,680 bytes. If ~3 KB you forgot --features bpf-entrypoint, rebuild.
```

- [ ] Binary built, size 88 KB confirmed

### 3.2 Deploy program

```bash
solana program deploy \
  --program-id ~/pact-mainnet-keys/pact-network-v1-program-keypair.json \
  packages/program/target/deploy/pact_network_v1.so
```

> No `--max-len` — ProgramData sized to the binary, rent ~0.62 SOL. To grow the binary later: `solana program extend <PROG_ID> <ADDITIONAL_BYTES>` first. Avoids the 7.3 SOL rent that `--max-len 1048576` would lock in.

Save the deploy signature. Verify:

```bash
solana program show 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc
# Authority must = JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL
# Data Length must be ~88,680
```

- [ ] Deploy succeeded
- [ ] Signature: ____________________
- [ ] `solana program show` confirms Authority + Data Length

### 3.3 Review endpoint config

Open `scripts/mainnet/endpoint-config.json`. Adjust premium values, SLA latencies, exposure caps per endpoint. Defaults are conservative.

- [ ] Reviewed and tuned

### 3.4 Rehearse init (DRY_RUN)

```bash
cd pact-monitor/scripts/mainnet
bun install
DRY_RUN=1 MAINNET_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY bun init
```

All 8 steps should print `DRY_RUN_*` placeholder signatures and exit clean. If anything errors, fix before §3.5.

- [ ] DRY_RUN passes

### 3.5 Run real init

```bash
MAINNET_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY bun init
```

State written to `scripts/mainnet/.mainnet-state.json`. Includes 8 tx signatures, all PDAs, vault addresses.

- [ ] All 8 init txs landed
- [ ] `.mainnet-state.json` written

### 3.6 Seed pool vaults with USDC

After init, each endpoint's `CoveragePool.usdc_vault` is empty. Send mainnet USDC from your treasury wallet to each pool vault address (printed in `.mainnet-state.json` under `endpoints[*].poolVault`).

For private beta with capped pool: $200-1000 per endpoint is fine. Adjust per `exposureCapPerHourLamports` in your config (default 10 USDC/hour).

```bash
# Per pool, using spl-token CLI (or Phantom):
spl-token transfer EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v <AMOUNT> <POOL_VAULT_ADDR>
```

- [ ] All 5 pools seeded

---

## Block 4 — Off-chain stack on Cloud Run (gated on Block 2 + Block 3)

Detailed runbook: `docs/mainnet-cloud-run-deploy.md`.

### 4.1 Fill TODO_FILL_AFTER_PROJECT_CREATION markers

Three files have placeholder text that needs your `project_number`:

```bash
# 1. terraform.tfvars
sed -i 's/TODO_FILL_AFTER_PROJECT_CREATION/<your_project_number>/g' \
  ~/devops/terraform-gcp/pact-network-prod/terraform.tfvars

# 2. + 3. GH workflows
sed -i 's/TODO_FILL_AFTER_PROJECT_CREATION/<your_project_number>/g' \
  ~/dev/pact-monitor/.github/workflows/build-pact-network.yaml \
  ~/dev/pact-monitor/.github/workflows/deploy-pact-network.yaml
```

Also fill `default_compute_sa` in terraform.tfvars: `<project_number>-compute@developer.gserviceaccount.com`.

- [ ] terraform.tfvars filled
- [ ] build-pact-network.yaml filled
- [ ] deploy-pact-network.yaml filled
- [ ] PR'd + merged the workflow updates to develop

### 4.2 Push devops branch + merge to main

```bash
cd ~/devops
git push origin feat/pact-network-prod-scaffold
# Open PR in https://github.com/Quantum3-Labs/devops, merge to main
```

- [ ] PR opened
- [ ] PR merged

### 4.3 terraform init + apply

```bash
cd ~/devops/terraform-gcp/pact-network-prod
terraform init
terraform plan       # review carefully
terraform apply
```

This creates: Cloud SQL `pact-network-prod-db`, Pub/Sub topic + DLQ + subscription, 3 Cloud Run services (placeholder containers), Artifact Registry `pact-network`, runtime SAs, CI/CD SA, WIF pool/provider, LB, secrets (empty).

Capture from `terraform output`:
- `lb_ip` (for DNS in Block 5)
- `cloud_run_uris` (informational)
- `cicd_service_account` (referenced in workflows)

- [ ] `terraform apply` succeeded
- [ ] `lb_ip`: ____________________

### 4.4 Populate secrets

```bash
PROJECT=pact-network-prod

# Alchemy API key (Pact's internal Solana RPC)
echo -n "<your_alchemy_key>" | gcloud secrets versions add PACT_ALCHEMY_API_KEY \
  --project=$PROJECT --data-file=-

# Helius API key (upstream for `helius` endpoint slug)
echo -n "<your_helius_key>" | gcloud secrets versions add PACT_HELIUS_API_KEY \
  --project=$PROJECT --data-file=-

# Settlement-authority keypair (mounted as file on settler)
gcloud secrets versions add PACT_SETTLEMENT_AUTHORITY_JSON \
  --project=$PROJECT \
  --data-file=~/pact-mainnet-keys/settlement-authority.json

# Indexer push secret — random hex, same value on settler + indexer
INDEXER_SECRET=$(openssl rand -hex 32)
echo -n "$INDEXER_SECRET" | gcloud secrets versions add PACT_INDEXER_PUSH_SECRET \
  --project=$PROJECT --data-file=-

# DB password — strong random; ALSO update Cloud SQL user
DB_PASS=$(openssl rand -base64 24)
echo -n "$DB_PASS" | gcloud secrets versions add PACT_DB_PASSWORD \
  --project=$PROJECT --data-file=-
gcloud sql users set-password pact --instance=pact-network-prod-db \
  --password="$DB_PASS" --project=$PROJECT
```

- [ ] PACT_ALCHEMY_API_KEY set
- [ ] PACT_HELIUS_API_KEY set
- [ ] PACT_SETTLEMENT_AUTHORITY_JSON set
- [ ] PACT_INDEXER_PUSH_SECRET set
- [ ] PACT_DB_PASSWORD set + Cloud SQL user updated

### 4.5 Add GitHub repo secrets

Go to <https://github.com/pactnetwork/pact-monitor/settings/secrets/actions>:

- `ENV_PROD` — yaml of build-time env. Template at `docs/mainnet-cloud-run-deploy.md` §3. Include things like `NODE_ENV`, `PROGRAM_ID`, `USDC_MINT`, `GOOGLE_CLOUD_PROJECT`, etc.
- `ORG_GITHUB_TOKEN` — if not already set (used for submodule checkout).

- [ ] ENV_PROD configured
- [ ] ORG_GITHUB_TOKEN confirmed

### 4.6 Trigger first deploys

Order: indexer first (so settler has a target), then settler, then market-proxy.

```bash
# Build (per service)
gh workflow run build-pact-network.yaml -f environment=production -f service_name=pact-indexer
gh workflow run build-pact-network.yaml -f environment=production -f service_name=pact-settler
gh workflow run build-pact-network.yaml -f environment=production -f service_name=pact-market-proxy

# Wait for builds to complete (gh run list / gh run watch)

# Deploy (per service) — first deploy needs --set-secrets to bind Secret Manager
gh workflow run deploy-pact-network.yaml -f environment=production -f service_name=pact-indexer
gh workflow run deploy-pact-network.yaml -f environment=production -f service_name=pact-settler
gh workflow run deploy-pact-network.yaml -f environment=production -f service_name=pact-market-proxy
```

- [ ] All 3 services built
- [ ] All 3 services deployed

### 4.7 Run prisma migrate deploy against Cloud SQL

The indexer's Dockerfile runs migrations on cold start (idempotent), so this typically auto-handles. Verify in indexer logs:

```bash
gcloud run services logs read pact-indexer --project=pact-network-prod --limit=200 | grep -i "migrat"
# Look for "Migration applied" or similar
```

If migrations didn't run automatically, invoke manually via Cloud Run Job or Cloud SQL Auth Proxy from your laptop.

- [ ] Migrations applied

---

## Block 5 — DNS + Vercel (gated on Block 4)

### 5.1 DNS A records

At your DNS provider for `pactnetwork.io`:

| Record | Type | Value |
|---|---|---|
| `api.pactnetwork.io` | A | `<lb_ip from terraform output>` |
| `indexer.pactnetwork.io` | A | `<same lb_ip>` |

Wait 15-30 min for Google-managed SSL certs to provision. Confirm:

```bash
gcloud compute ssl-certificates list --project=pact-network-prod
# Status should reach ACTIVE
```

- [ ] api.pactnetwork.io A record set
- [ ] indexer.pactnetwork.io A record set
- [ ] SSL certs ACTIVE

### 5.2 Vercel — market-dashboard

```bash
cd pact-monitor/packages/market-dashboard
vercel link
# follow prompts to create/link project

vercel env add NEXT_PUBLIC_USDC_MINT production
# value: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

vercel env add NEXT_PUBLIC_INDEXER_URL production
# value: https://indexer.pactnetwork.io

vercel env add NEXT_PUBLIC_RPC_URL production
# value: https://solana-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

vercel env add NEXT_PUBLIC_PROGRAM_ID production
# value: 5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc

vercel --prod
```

Add custom domain `app.pactnetwork.io` in Vercel dashboard. CNAME at your DNS:

| Record | Type | Value |
|---|---|---|
| `app.pactnetwork.io` | CNAME | `cname.vercel-dns.com` |

- [ ] Vercel project linked
- [ ] 4 env vars set
- [ ] Production deployed
- [ ] app.pactnetwork.io CNAME set

---

## Block 6 — Verify + first user (gated on Block 5)

### 6.1 Health checks

```bash
curl https://api.pactnetwork.io/health
curl https://indexer.pactnetwork.io/health
# Both should return 200
```

I (Claude) can do this from the dev VM. Tell me when Block 5 is done.

- [ ] api.pactnetwork.io healthy
- [ ] indexer.pactnetwork.io healthy

### 6.2 Mainnet 10-call smoke

I drive this from the dev VM. You need to:
1. Fund a dedicated test agent with ~$1 USDC on its mainnet ATA
2. Set up SPL Token Approval delegate to settlement-authority for that test agent
3. Send me the test agent pubkey and confirm allowlist for the latency_breach slot

I run `scripts/mainnet-smoke/00-preflight.ts` → `01-fire-10-calls.ts` → `02-reconcile.ts`. Reconciliation must match for all 5 endpoints + Treasury.

- [ ] Test agent funded
- [ ] SPL approval set
- [ ] Smoke passes (I report PASS/FAIL)

### 6.3 First user invite

We send your selected first user:
- The disclosure doc (`docs/beta-user-disclosure.md` — fill the `<!-- TODO: insert contact -->` placeholder)
- The proxy URL: `https://api.pactnetwork.io/v1/<slug>/...`
- A short onboarding email/Slack with: program ID, USDC mint, expected approval flow, dashboard URL

- [ ] Disclosure doc finalized (contact filled in)
- [ ] First user invited

### 6.4 Tag the launch

```bash
cd pact-monitor
git checkout main
git pull
git merge develop
git tag v1.0.0-mainnet -m "V1 mainnet launch"
git push origin main --tags
```

(Do this AFTER smoke passes, per the `develop → main` strategy we settled on.)

- [ ] develop → main merged
- [ ] v1.0.0-mainnet tag pushed

---

## What I'm doing in parallel (no action from you)

- Watching for B11/B12-class issues in indexer logs once stack is live
- Running mainnet 10-call smoke (Block 6.2) when you green-light it
- Drafting onboarding email template for first user (per Block 6.3)
- Available for any "this errored, what does it mean" troubleshooting

---

## Decisions you still owe me

1. **Devops branch merge order** (Block 2.3) — A/B/C
2. **Pool seeding amounts** (Block 3.6) — exact USDC per pool
3. **First selected user** (Block 6.3) — who gets the invite
4. **Disclosure contact placeholder** (Block 6.3) — Telegram group, email, etc.
5. **Cloud SQL tier** — terraform currently has `db-f1-micro`. If you expect >100 calls/min at beta, bump to `db-custom-1-3840`.
6. **Region** — terraform sets `asia-southeast1`. If beta users are US/EU-concentrated, change before `terraform apply`.

---

## Hard constraints

- Don't skip §3.4 DRY_RUN before §3.5 real init — the dry-run catches misconfigured keypairs/RPC before spending SOL.
- Don't push devops `feat/pact-network-prod-scaffold` until §4.1 TODO markers are filled. The branch is currently local; the placeholder text would land in main otherwise.
- Don't fund the upgrade-authority pubkey BEFORE you've confirmed §1.2 backups. If you lose access pre-deploy, the SOL is stuck.
- The `pause_protocol` kill switch (`scripts/mainnet/pause-protocol.ts`) is your incident-response lever. Test it on devnet first if you've never run it. Use `DRY_RUN=1` mode to rehearse without sending a real tx.

---

## Estimated cost (one-time + monthly)

**One-time on launch day:**
- ~0.62 SOL program rent + 0.05 SOL init txs = **~$135** (at ~$200/SOL)
- ~$1000 USDC seed split across 5 pools (your call on amount)

**Recurring monthly:**
- GCP infra: **~$110-185/mo** (per `docs/mainnet-cloud-run-deploy.md` §6)
- Alchemy: $0 during free credits, $0-50/mo after
- Helius (upstream for `helius` slug): $0-50/mo at beta volume
- Mainnet SOL for `settle_batch` fees: <$10/mo at beta volume
- Vercel hobby: $0-20/mo

**Total burn rate at private beta:** ~$120-265/mo + amortized launch cost.

---

## Questions? Re-read these in order:
1. This file (you are here)
2. `docs/mainnet-program-deploy.md` — Block 3 detail
3. `scripts/mainnet/README.md` — Block 3.4-3.6 detail
4. `docs/mainnet-cloud-run-deploy.md` — Block 4 detail
5. `docs/beta-user-disclosure.md` — Block 6.3 content

Or ping me.
