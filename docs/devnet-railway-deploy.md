# Pact Network V1 — Devnet Railway Deploy Runbook

Step-by-step deploy guide for the Railway-hosted devnet stack. **Audience: Rick.**

For the design rationale (Railway vs GCP, queue-substrate choice, mainnet safety boundary), see the plan at `docs/superpowers/plans/2026-05-15-devnet-mirror-build.md` (branch `plan/devnet-mirror-build`).

> **This does not touch mainnet.** Mainnet stays on GCP at its current image SHAs. `deploy-pact-network.yaml` is `workflow_dispatch` only — landing this devnet stack does not redeploy any mainnet service.

---

## 0. Pre-flight (one-time)

Confirm you have:
- Railway account (https://railway.app) with billing enabled (Hobby $5/mo + usage)
- Vercel DNS access for `pactnetwork.io` (or whoever holds the zone today)
- Helius account with a **new devnet** API key generated under the existing project (per plan §12 settled decisions)
- Devnet upgrade-authority keypair at `~/.config/solana/...` (per plan §12 — reusing existing dev hot key)
- Test agent keypair generated for the post-deploy smoke (see `scripts/devnet-smoke/README.md` §Phase 2)

---

## 1. Create the Railway project

In the Railway dashboard:

1. **New Project** → name it `pact-network-devnet`.
2. **Region:** `asia-southeast1` (matches mainnet GCP region per plan §12).
3. Once the project exists, open **Settings → Tokens** and generate a **Project Token**. Keep it handy for the optional `railway` CLI later.

---

## 2. Add plugins (Postgres + Redis)

In the project:

1. **New → Database → Postgres**. Railway provisions a small Postgres 16 instance and exposes `${{Postgres.DATABASE_URL}}` as a project-wide variable reference.
2. **New → Database → Redis**. Same flow. Exposes `${{Redis.REDIS_URL}}`.

Both plugins start with 256 MB RAM allocations — sufficient for devnet load. Bump up later if needed.

---

## 3. Create the 4 services (from GitHub)

For each of `market-proxy`, `settler`, `indexer`, `market-dashboard`:

1. **New → GitHub Repo → `Quantum3-Labs/pact-monitor`** (authenticate Railway with the org's GitHub if first time).
2. **Branch:** `develop` (per plan §12 settled decisions — `develop` is the single source of truth for both mainnet and devnet).
3. **Service Name:** `market-proxy` / `settler` / `indexer` / `market-dashboard` (keep them simple — Railway-internal naming).
4. **Settings → Root Directory:** `/` (repo root — Docker build context must include the pnpm workspace).
5. **Settings → Config Path:** `packages/<service>/railway.json` (e.g. `packages/market-proxy/railway.json`). This points Railway at the per-service config that was committed to `develop`.
6. **Settings → Watch Paths** (so only relevant changes trigger that service's redeploy):

| Service | Watch paths |
|---|---|
| `market-proxy` | `packages/market-proxy/**`, `packages/wrap/**`, `packages/protocol-v1-client/**`, `packages/shared/**` |
| `settler` | `packages/settler/**`, `packages/wrap/**`, `packages/protocol-v1-client/**`, `packages/shared/**` |
| `indexer` | `packages/indexer/**`, `packages/db/**`, `packages/shared/**` |
| `market-dashboard` | `packages/market-dashboard/**` |

7. **Settings → Resource Limits:** 0.5 vCPU / 512 MB for proxy/settler/indexer; 1.0 vCPU / 512 MB for dashboard (Next.js SSR needs the CPU headroom).

---

## 4. Configure env vars per service

For each service, open **Variables** and paste the contents of the corresponding `packages/<service>/.env.devnet.example` file. **Before pasting**, substitute the placeholders:

| Placeholder | What goes there |
|---|---|
| `<HELIUS_DEVNET_API_KEY>` | The new devnet API key you created in §0 |
| `<OPENSSL_RAND_HEX_32>` | Run `openssl rand -hex 32` — generate **once** and reuse the same value for `INDEXER_PUSH_SECRET` on **both** settler and indexer services. Mainnet Bug 2 mitigation (memory `mainnet_first_settle_2026_05_07.md`). |
| `<BASE58_KEYPAIR_FROM_~/.config/solana/>` | Run `cat ~/.config/solana/<file>.json \| solana-keygen pubkey --outfile - --skip-seed-phrase-validation` to confirm the pubkey, then convert the 64-byte JSON array to base58 via `pnpm tsx -e "import bs58 from 'bs58'; import { readFileSync } from 'node:fs'; console.log(bs58.encode(Uint8Array.from(JSON.parse(readFileSync(process.argv[1],'utf8')))))" /path/to/key.json` |

**Dashboard build vars:** the `NEXT_PUBLIC_*` fields in `packages/market-dashboard/.env.devnet.example` must go under **Settings → Build → Build Variables**, not the regular Variables tab. Next.js bakes them into the client bundle at build time; setting them as runtime vars has no effect.

---

## 5. Add custom domains

For each public-facing service, **Settings → Networking → Custom Domain**:

| Service | Domain |
|---|---|
| `market-proxy` | `api-devnet.pactnetwork.io` |
| `indexer` | `indexer-devnet.pactnetwork.io` |
| `market-dashboard` | `app-devnet.pactnetwork.io` |

Railway will show a CNAME target like `<some-id>.up.railway.app`. **Do not** add the custom domain in Railway until DNS is in place — Railway's Let's Encrypt challenge fires immediately on attach, and a not-yet-resolving CNAME will keep the cert in `PROVISIONING` indefinitely.

The settler does **not** get a custom domain. Internal traffic from market-proxy → indexer uses `${{indexer.RAILWAY_PRIVATE_DOMAIN}}`; settler talks to indexer the same way. No external need.

---

## 6. Add Vercel DNS CNAMEs

In the Vercel DNS panel for `pactnetwork.io`:

```
api-devnet      CNAME   <railway-cname-from-step-5>.up.railway.app
indexer-devnet  CNAME   <railway-cname-from-step-5>.up.railway.app
app-devnet      CNAME   <railway-cname-from-step-5>.up.railway.app
```

Wait ~60s for DNS to propagate (`dig api-devnet.pactnetwork.io` should return the Railway CNAME chain).

**Now** go back to Railway and attach the 3 custom domains from step 5. Let's Encrypt provisioning typically takes 30–60s once DNS resolves.

---

## 7. Trigger first deploys

Push to `develop` triggers Railway auto-deploys for any service whose watch paths matched. Order matters for the first cold boot:

1. **indexer** first — its `preDeployCommand` runs `prisma migrate deploy` against the Railway Postgres plugin. Watch the deploy logs in Railway; you should see `Migration ... applied`. If migrations fail, fix and redeploy before moving on.
2. **market-proxy** second.
3. **settler** third — depends on indexer being reachable for its push-secret guard.
4. **market-dashboard** last (no dependencies but the slowest cold start).

If Railway auto-deploys in the wrong order, that's fine — just let it settle, then restart any service that boot-failed.

---

## 8. Solana on-chain init

The devnet program is already deployed at `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`, but the PDAs (ProtocolConfig, Treasury, SettlementAuthority, helius EndpointConfig + CoveragePool) may need re-init if devnet has been wiped or this is the first integrated run:

```sh
# From your laptop where the keypair lives — NOT from the dev VM.
solana program show 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 --url devnet

bun packages/protocol-v1-client/scripts/check-init.ts --cluster devnet
# If anything is uninitialized:
bun packages/protocol-v1-client/scripts/init-protocol.ts \
  --cluster devnet \
  --authority 47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS \
  --treasury-bps 100

# Register the `helius` endpoint with the settler signer as fee recipient.
# Replace <SETTLER_SIGNER_PUBKEY> with the pubkey corresponding to the
# SETTLEMENT_AUTHORITY_KEY value you set on the settler service.
bun packages/protocol-v1-client/scripts/register-endpoint.ts \
  --cluster devnet \
  --slug helius \
  --fee-recipient <SETTLER_SIGNER_PUBKEY> \
  --flat-premium 1000 \
  --sla-latency-ms 200
```

Fund the settler signer with ≥ 0.05 devnet SOL (~5,000 settles at 10k lamports each — mainnet Bug 1 mitigation):

```sh
solana airdrop 1 <SETTLER_SIGNER_PUBKEY> --url devnet
# Devnet faucet caps at 1 SOL/call with ~12h cooldown per IP; retry if rate-limited.
```

---

## 9. Smoke test

```sh
# Phase 1: autonomous health probe (no agent keypair needed)
./scripts/devnet-smoke/health.sh

# Phase 2: 10-call end-to-end (see scripts/devnet-smoke/README.md)
# Requires test agent keypair + spl-token approve on the agent's USDC ATA.
```

Pass criteria mirror plan §8. If health.sh passes and the 10-call smoke
reconciles to the expected `(calls=10, premium=10000, pool=9000, treasury=1000)`,
devnet is live.

---

## 10. Rollback

Railway keeps the previous deploy. To roll back:

1. **Service → Deployments tab → previous successful deploy → Rollback.**

If a bad code change on `develop` broke devnet, the right fix is to land a hotfix on `develop`. Do **not** push directly to a `devnet`-only branch — per plan §12 settled decisions there is no separate `devnet` branch; both environments draw from `develop`.

If something is wrong with the Railway project itself (queue stuck, Postgres dead, etc.):
- **Queue stuck:** `redis-cli -u $REDIS_URL FLUSHALL` (devnet only — would be catastrophic on mainnet)
- **Postgres dead:** Railway → Postgres plugin → Settings → Reset Database. Re-run the indexer to repopulate via `prisma migrate deploy`.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cert stuck in `PROVISIONING` | DNS hadn't propagated when domain attached | Detach custom domain, wait for `dig` to return Railway CNAME, re-attach |
| Indexer boot fails with `Database migration failed` | Prisma version mismatch or schema drift | Check logs: usually a SHADOW database permission issue on Railway Postgres. `prisma migrate deploy` does NOT need a shadow DB; if it tries to use one, you accidentally ran `migrate dev` somewhere. |
| Settler logs flood with `XACK ... failed` | Redis URL typo or auth failure | Verify `REDIS_URL` matches `${{Redis.REDIS_URL}}` exactly; restart settler |
| Indexer 401s every settler push | `INDEXER_PUSH_SECRET` mismatch between settler and indexer (mainnet Bug 2 redux) | Re-paste the same hex value into both services; restart settler |
| `endpoints_loaded: 0` on `/health` forever | Chain-sync hasn't found the `helius` EndpointConfig PDA on devnet | Verify on-chain init in §8 completed; check indexer logs for `SOLANA_RPC_URL` errors |
| Dashboard 200s but shows wrong data | `NEXT_PUBLIC_*` set as runtime vars instead of build vars | Move to **Settings → Build → Build Variables**; trigger a redeploy |

---

## 12. Cost monitoring

Railway Hobby is $5/mo + usage. Expected devnet monthly all-in: **$15–25** at light traffic.

Set an auto-recharge cap at **$30/mo** in Railway → Project → Settings → Billing. If devnet ever sustained-loads hard (cumulative usage > cap), the project pauses gracefully — Postgres + Redis data persists, services suspend until you top up. No data loss.

---

## 13. References

- Plan + design rationale: `docs/superpowers/plans/2026-05-15-devnet-mirror-build.md` (branch `plan/devnet-mirror-build`)
- Mainnet equivalent runbook: `docs/mainnet-cloud-run-deploy.md`
- Queue adapter PR: #199 (merged 2026-05-15)
- Memory: `mainnet_offchain_stack.md`, `mainnet_first_settle_2026_05_07.md`, `cloud_armor_ua_filter.md`
