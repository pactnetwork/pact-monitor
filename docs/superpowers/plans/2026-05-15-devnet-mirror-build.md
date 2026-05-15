# Pact Network — Devnet Mirror Build Plan (Railway)

**Date:** 2026-05-15
**Owner:** Rick
**Goal:** Stand up a public devnet stack on Railway that is a **behavioral** mirror of the live mainnet stack — same code, same env contract, same on-chain semantics — but with the cloud topology simplified from GCP (Cloud Run + Pub/Sub + Cloud SQL + LB + Secret Manager + Terraform) down to Railway primitives (services + Postgres plugin + Redis plugin + custom domains + env vars).

**Why not the GCP-mirror plan:** rejected on cost-of-complexity grounds. Devnet doesn't need scale-to-zero billing, per-secret IAM, Cloud Armor, multi-region failover, or 99.9% SLOs. The earlier `~/devops`-compliant GCP plan is summarized in §15 if mainnet-identical infrastructure ever becomes a requirement.

---

## 0. Boundary — what does NOT change

**Mainnet stays on GCP. This plan touches zero mainnet infrastructure.** Devnet on Railway is fully isolated: different cloud, different DB, different queue, different DNS, different secrets, different service accounts. No shared runtime state.

| Mainnet asset | State after this plan |
|---|---|
| GCP project `pact-network` (224627201825) | Unchanged |
| Cloud Run services `pact-{market-proxy, settler, indexer, market-dashboard}` | Unchanged — keep running their current image SHAs |
| Cloud SQL Postgres, Pub/Sub topic + DLQ + subscription, Cloud LB IP `34.49.161.166`, 3 managed SSL certs | Unchanged |
| Secret Manager secrets, IAM bindings, runtime service accounts | Unchanged |
| `~/devops/terraform-gcp/pact-network/` Terraform workspace | Zero TF changes |
| `ENV_PROD` GitHub secret | Untouched |
| DNS A records for `api.pactnetwork.io`, `indexer.pactnetwork.io`, `app.pactnetwork.io` | Untouched |
| Devnet program ID `5jBQb7fL…` and mainnet program ID `5bCJcdWdK…` | Both unchanged on-chain |

**Mainnet image-freeze property.** `deploy-pact-network.yaml` is `workflow_dispatch` only. The mainnet Cloud Run services keep running their current image SHAs until Rick explicitly clicks "Run workflow" → `production`. **Landing the queue-adapter PR on `develop` does not redeploy mainnet** — `develop`'s on-disk code can diverge from the production image SHA indefinitely with no production-side effect.

When Rick eventually chooses to deploy a post-adapter image to mainnet (for any reason), the §10 gates apply. Until then, mainnet is frozen and unaffected by this work.

The only thing devnet and mainnet share is:
- The Solana program (`5jBQb7fL…` on devnet, `5bCJcdWdK…` on mainnet — both already deployed, not touched here)
- The source code on `develop` after the queue-adapter PR lands

---

## 1. Scope clarification — what "mirror" means here

Three things must mirror exactly:

1. **The code** running in each service (same Docker images, off the same monorepo, off `develop` HEAD).
2. **The env contract** each service reads (same variable names, devnet-specific values).
3. **The on-chain semantics** (same program family, same instructions, same fee splits).

Three things deliberately do **not** mirror:

1. **The queue substrate.** Mainnet uses GCP Pub/Sub. Devnet uses Redis Streams (consumer groups + pending entries + XACK gives durability + DLQ-equivalent semantics). Abstracted behind an adapter so application code is identical.
2. **The DB host.** Mainnet uses Cloud SQL via unix socket (Prisma `migrate deploy` doesn't work over it; mainnet uses raw psql Job). Devnet uses Railway Postgres over TCP, where `prisma migrate deploy` works natively — strictly simpler.
3. **The secrets store.** Mainnet uses Secret Manager + IAM. Devnet uses Railway env vars (encrypted at rest, scoped per service).

---

## 2. Constraints (locked)

| Item | Value |
|---|---|
| Platform | Railway Hobby ($5/mo + usage; ~$15–25/mo all-in) |
| Project name | `pact-network-devnet` (one Railway project, 4 services + 2 plugins) |
| Public DNS | `api-devnet.pactnetwork.io`, `indexer-devnet.pactnetwork.io`, `app-devnet.pactnetwork.io` (CNAMEs to Railway-provided per-service hostnames) |
| Solana network | devnet — RPC `https://devnet.helius-rpc.com/?api-key=…` primary, `https://api.devnet.solana.com` fallback |
| Program ID | `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` (already deployed) |
| Upgrade authority | `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` (devnet hot key OK) |
| USDC mint | `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` (devnet USDC) |
| Source-of-truth branch | `develop` — single branch feeding both environments. No separate `devnet` branch. |
| Devnet deploy trigger | Railway watches `develop` directly; auto-deploys every push (per-service Dockerfile + watch paths gate which service rebuilds) |
| Mainnet deploy trigger | `workflow_dispatch` on `deploy-pact-network.yaml` (manual, unchanged from today). Builds from `develop` HEAD when Rick clicks "Run workflow" → `production` |
| Drift property | Structurally zero — both environments draw from the same commit graph. Devnet is always == `develop`. Mainnet pins to whatever SHA Rick last deployed. |

---

## 3. Architecture on Railway

```
                   Solana devnet
                        ▲
                ┌───────┼───────┐
                │ RPC   │ RPC   │ RPC
                │       │       │
    ┌───────────┴─┐ ┌───┴────┐ ┌┴───────────┐
    │ market-     │ │settler │ │ indexer    │
    │ proxy       │ │(worker)│ │ (HTTP)     │
    │ (HTTP)      │ │always- │ │            │
    └─────┬───┬───┘ │  on    │ └─┬────────┬─┘
          │   │     └───┬────┘   │        │
          │   │ XADD    │ XREAD  │ TCP    │ HTTP push
          │   │         │ XACK   │        │
          │   ▼         ▼        ▼        │
          │ ┌────────────────┐ ┌──────────┴─┐
          │ │ Railway Redis  │ │ Railway    │
          │ │ (Streams = queue│ │ Postgres   │
          │ │  + DLQ via PEL)│ │ (Prisma)   │
          │ └────────────────┘ └────────────┘
          │
          │ (dashboard reads indexer via NEXT_PUBLIC_INDEXER_URL)
          │
    ┌─────┴─────────────┐
    │ market-dashboard  │ ← Next.js 15 standalone on Railway
    └───────────────────┘
                ▲
                │ CNAMEs from Vercel DNS
            users / agents
```

Service mapping:

| Mainnet (GCP, frozen) | Devnet (Railway, new) | Type | Public domain |
|---|---|---|---|
| `pact-market-proxy` Cloud Run | `market-proxy` Railway service | HTTP, scales 1+ | `api-devnet.pactnetwork.io` |
| `pact-settler` Cloud Run (internal) | `settler` Railway service | Always-on worker | none (internal) |
| `pact-indexer` Cloud Run | `indexer` Railway service | HTTP, scales 1+ | `indexer-devnet.pactnetwork.io` |
| `pact-market-dashboard` Cloud Run | `dashboard` Railway service | HTTP (Next.js standalone) | `app-devnet.pactnetwork.io` |
| Cloud SQL Postgres | Railway Postgres plugin | — | internal |
| Pub/Sub topic + sub + DLQ | Railway Redis plugin + Streams | — | internal |
| Secret Manager (6 secrets) | Railway env vars per service | — | — |
| Cloud LB + 3 SSL certs | Railway custom domains (auto LE) | — | — |
| Cloud Run Job `pact-migrate-psql` | `prisma migrate deploy` as indexer start | — | — |

---

## 4. Code changes (the only material engineering work)

### 4.1 Queue adapter in `@pact-network/wrap`

Extend `packages/wrap/src/eventSink.ts` with a `RedisStreamsEventSink` alongside the existing `PubSubEventSink` / `HttpEventSink` / `MemoryEventSink`. Same `EventSink` interface (`publish(event): Promise<void>`, fire-and-forget). `ioredis` declared as `optional` peerDep — same pattern `@google-cloud/pubsub` already uses.

### 4.2 Sink factory in `packages/market-proxy/src/lib/events.ts`

Add a `createEventSink()` factory that dispatches on `QUEUE_BACKEND` env:

```ts
export function createEventSink(): EventSink {
  const backend = process.env.QUEUE_BACKEND ?? "pubsub";
  if (backend === "redis-streams") {
    const Redis = require("ioredis");
    return new RedisStreamsEventSink(
      new Redis(process.env.REDIS_URL!),
      process.env.REDIS_STREAM ?? "pact-settle-events"
    );
  }
  return createPubSubSink(process.env.PUBSUB_PROJECT!, process.env.PUBSUB_TOPIC!);
}
```

**Default `pubsub` preserves mainnet behavior with zero env-var changes on production.** Update single call site at `packages/market-proxy/src/lib/context.ts:45`.

### 4.3 Settler consumer abstraction

`packages/settler/src/consumer/consumer.service.ts` (72 lines) tightly couples to `@google-cloud/pubsub`. Refactor:

1. `QueueConsumer` interface in `consumer/queue-consumer.interface.ts`
2. Rename existing impl to `PubSubQueueConsumer` (no behavior change)
3. New `RedisStreamsQueueConsumer` using `XREADGROUP` + `XACK` + `XCLAIM`. DLQ via `XADD` to `pact-settle-events-dlq` when delivery count > 10 (mirrors mainnet `max_delivery_attempts = 10`)
4. `ConsumerModule` selects backend by `QUEUE_BACKEND`. `PubSub` provider only constructed when `QUEUE_BACKEND !== "redis-streams"` (default = same as today)
5. Existing tests pass against Pub/Sub path unchanged. New parallel spec for Redis path using `ioredis-mock`

**Expected diff:** ~300 added lines, ~30 changed in existing files. Single PR.

### 4.4 Settler env schema (`packages/settler/src/config/env.ts`)

Add `QUEUE_BACKEND` (default `"pubsub"`), `REDIS_URL`, `REDIS_STREAM`, `REDIS_CONSUMER_GROUP` as optional. Zod refinement: if `QUEUE_BACKEND === "pubsub"`, `PUBSUB_PROJECT` + `PUBSUB_SUBSCRIPTION` required (existing behavior). If `"redis-streams"`, `REDIS_*` required. Schema test: parsing mainnet's verbatim `ENV_PROD` (no `QUEUE_BACKEND`) must succeed.

### 4.5 Indexer migration

Indexer start command: `pnpm prisma migrate deploy && node dist/main.js`. Works on Railway TCP Postgres; doesn't apply to mainnet's Cloud SQL socket path.

### 4.6 Dashboard build args

Railway service-level build vars:
```
NEXT_PUBLIC_INDEXER_URL=https://indexer-devnet.pactnetwork.io
NEXT_PUBLIC_USDC_MINT=Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr
NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com
```

---

## 5. Railway project setup

### 5.1 Init

```sh
railway init pact-network-devnet
railway add --plugin postgresql
railway add --plugin redis
```

Yields `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` as cross-service variable references.

### 5.2 Services

Each connected to `Quantum3-Labs/pact-monitor` with package-specific Dockerfile + watch paths so only relevant changes redeploy:

| Service | Dockerfile | Watch paths |
|---|---|---|
| `market-proxy` | `packages/market-proxy/Dockerfile` | `packages/market-proxy/**`, `packages/wrap/**`, `packages/protocol-v1-client/**`, `packages/shared/**` |
| `settler` | `packages/settler/Dockerfile` | `packages/settler/**`, `packages/wrap/**`, `packages/protocol-v1-client/**`, `packages/shared/**` |
| `indexer` | `packages/indexer/Dockerfile` | `packages/indexer/**`, `packages/db/**`, `packages/shared/**` |
| `dashboard` | `packages/market-dashboard/Dockerfile` | `packages/market-dashboard/**` |

### 5.3 Env vars per service

| Service | Variables |
|---|---|
| `market-proxy` | `QUEUE_BACKEND=redis-streams`, `REDIS_URL=${{Redis.REDIS_URL}}`, `REDIS_STREAM=pact-settle-events`, `SOLANA_RPC_URL`, `PROGRAM_ID=5jBQb7fLz…`, `USDC_MINT=Gh9ZwEmd…`, `INDEXER_URL=https://indexer-devnet.pactnetwork.io`, `ENDPOINTS_RELOAD_TOKEN`, `PACT_HELIUS_API_KEY`, `PORT=8080` |
| `settler` | `QUEUE_BACKEND=redis-streams`, `REDIS_URL=${{Redis.REDIS_URL}}`, `REDIS_STREAM=pact-settle-events`, `REDIS_CONSUMER_GROUP=settler`, `SOLANA_RPC_URL`, `PROGRAM_ID=5jBQb7fLz…`, `USDC_MINT=Gh9ZwEmd…`, `SETTLEMENT_AUTHORITY_KEY=<base58 keypair>`, `INDEXER_URL=https://${{indexer.RAILWAY_PRIVATE_DOMAIN}}`, `INDEXER_PUSH_SECRET`, `LOG_LEVEL=log`, `PORT=8080` |
| `indexer` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `INDEXER_PUSH_SECRET`, `PORT=8080` |
| `dashboard` | Build vars: `NEXT_PUBLIC_*` (see 4.6); Runtime: `PORT=3000` |

Generate `INDEXER_PUSH_SECRET` once (`openssl rand -hex 32`) and paste identically into settler + indexer (mainnet Bug 2 mitigation pattern).

### 5.4 Custom domains

For each public service → Settings → Networking → Custom Domain. Railway shows a CNAME target. Vercel DNS gets 3 CNAMEs:
- `api-devnet` → market-proxy's `*.up.railway.app`
- `indexer-devnet` → indexer's `*.up.railway.app`
- `app-devnet` → dashboard's `*.up.railway.app`

LE cert provisioning typically < 60s after DNS propagates.

### 5.5 Resource limits

| Service | CPU | RAM |
|---|---|---|
| `market-proxy` | 0.5 vCPU | 512 MB |
| `settler` | 0.5 vCPU | 512 MB |
| `indexer` | 0.5 vCPU | 512 MB |
| `dashboard` | 1.0 vCPU | 512 MB |
| Postgres | (managed) | 256 MB |
| Redis | (managed) | 256 MB |

Est. all-in: $15–25/mo light traffic.

---

## 6. On-chain init

1. `solana program show 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 --url devnet`
2. `bun packages/protocol-v1-client/scripts/check-init.ts --cluster devnet`
3. If uninitialized: `bun packages/protocol-v1-client/scripts/init-protocol.ts --cluster devnet --authority 47Fg5JqM… --treasury-bps 100`
4. Register `helius` endpoint with settler signer's pubkey as fee recipient
5. Fund settler signer ≥ 0.05 devnet SOL via `solana airdrop`

Settler signer keypair: reuse existing dev hot key at `~/.config/solana/` (Rick's laptop). Convert to base58 via `solana-keygen pubkey --outfile /dev/stdout <keypair.json> | base58` (or equivalent). Paste base58 into Railway `SETTLEMENT_AUTHORITY_KEY` env var on the `settler` service. Pubkey gets registered as `helius` endpoint fee recipient in step 4. See §12 note on the deliberate dev/mainnet separation difference.

---

## 7. Execution order

| Step | Depends on | Action |
|---|---|---|
| 1 | — | PR on `pact-monitor`: §4.1–4.4 queue adapter. CI green. |
| 2 | 1 merged to `develop` | Create Railway project, add Postgres + Redis plugins |
| 3 | 2 | Create 4 services, point at GitHub repo + Dockerfiles |
| 4 | 3 | Set env vars per service (§5.3); generate `INDEXER_PUSH_SECRET` |
| 5 | 4 | Trigger first deploys: indexer → market-proxy + settler → dashboard |
| 6 | 5 | Verify indexer ran `prisma migrate deploy`; tables present |
| 7 | 5 | Generate settler signer keypair; paste base58 into settler env; record pubkey |
| 8 | 7 | On-chain init (§6); fund settler signer |
| 9 | 5 | 3 custom domains; 3 Vercel CNAMEs; wait for LE certs |
| 10 | 8 + 9 | Smoke test (§8) |

---

## 8. Smoke test

`scripts/devnet-smoke/`:

1. `curl https://api-devnet.pactnetwork.io/health` → `{"status":"ok","endpoints_loaded":>0}`
2. `curl https://indexer-devnet.pactnetwork.io/health` → `{"status":"ok"}`
3. `curl https://indexer-devnet.pactnetwork.io/api/stats` → real-zeroes JSON
4. `curl https://app-devnet.pactnetwork.io/` → 200, dashboard HTML
5. 10-call `helius` smoke with devnet-USDC-funded agent:
   - 10 settle_batch txs on Solana Explorer (`?cluster=devnet`)
   - Indexer `/api/stats` shows `calls=10, premium=10000, pool=9000, treasury=1000`
   - `GET /api/agents/<pubkey>/calls?limit=10` returns 10 rows, does NOT 500 (PR #113 regression check)
6. Redis Streams: `XLEN pact-settle-events` = 0 (all acked); `XPENDING` shows no stuck entries

---

## 9. Acceptance criteria

- [ ] Queue-adapter PR merged; mainnet behavior unchanged (existing tests pass; `QUEUE_BACKEND` defaults to `pubsub`)
- [ ] Railway project healthy: 4 services + Postgres + Redis
- [ ] 3 custom domains with valid LE certs
- [ ] Settler signer ≥ 0.05 devnet SOL
- [ ] `INDEXER_PUSH_SECRET` matches between settler and indexer
- [ ] Protocol initialized on devnet with `helius` endpoint
- [ ] 10-call smoke passes; indexer totals match on-chain exactly
- [ ] `GET /api/agents/:pubkey/calls` returns rows (no 500)
- [ ] No stuck `XPENDING` entries after 1-hour soak
- [ ] `docs/devnet-railway-deploy.md` committed
- [ ] Monthly Railway cost ≤ $25

---

## 10. Mainnet safety — invariants and verification

### 10.1 The single invariant

> **With `QUEUE_BACKEND` unset (or `=pubsub`), the proxy and settler behave bit-for-bit identically to today.**

Same NestJS providers constructed, same `@google-cloud/pubsub` calls, same env-var requirements, same wire format on the topic, same DLQ behavior.

### 10.2 What changes in mainnet's code path

| Component | Today | After PR (mainnet, `QUEUE_BACKEND` unset) | Risk |
|---|---|---|---|
| `packages/wrap/src/eventSink.ts` | 4 sinks | adds `RedisStreamsEventSink` (additive export) | None — not imported on mainnet |
| `packages/wrap/package.json` peerDeps | `@google-cloud/pubsub` (optional) | adds `ioredis` (optional, same pattern) | None — optional, no install failure |
| `packages/market-proxy/src/lib/events.ts` | `createPubSubSink(p, t)` | adds `createEventSink()`; default branch byte-identical to `createPubSubSink` | Must keep `createRequire` lazy-load pattern |
| `packages/market-proxy/src/lib/context.ts:45` | calls `createPubSubSink(env.PUBSUB_PROJECT, env.PUBSUB_TOPIC)` | calls `createEventSink()` reading same env | Identical with `QUEUE_BACKEND` unset |
| `packages/settler/src/consumer/consumer.service.ts` | direct `@google-cloud/pubsub` | renamed `PubSubQueueConsumer`, implements `QueueConsumer` | DI provider `ConsumerService` kept as alias |
| `packages/settler/src/consumer/consumer.module.ts` | eager `new PubSub()` | conditional — eager only when `QUEUE_BACKEND !== "redis-streams"` | Default = same as today |
| `packages/settler/src/config/env.ts` | `PUBSUB_*` required | adds optional fields; conditional refinement; `PUBSUB_*` still required when `QUEUE_BACKEND` is "pubsub" or unset | Schema test against frozen mainnet env snapshot |
| Dockerfiles | unchanged | unchanged; image +~600 KB (ioredis) | None |

### 10.3 Pre-merge gate (reviewer checklist)

- [ ] All existing settler tests pass unchanged: `consumer.service.spec.ts`, `submitter.service.spec.ts`, `batcher.service.spec.ts`, `pipeline.e2e.spec.ts`, `indexer-pusher.service.spec.ts`, `secret-loader.service.spec.ts`
- [ ] Existing market-proxy tests pass: `test/events.test.ts`
- [ ] New test: with `process.env.QUEUE_BACKEND` unset + mainnet env snapshot, settler boots, `new PubSub()` is constructed, no `ioredis` import is reached
- [ ] New test: with `QUEUE_BACKEND=pubsub` explicitly set, behavior identical to unset
- [ ] New test: with `QUEUE_BACKEND=redis-streams`, Pub/Sub provider NOT constructed
- [ ] Schema test: parsing verbatim mainnet `ENV_PROD` keys succeeds (frozen golden file `test/fixtures/mainnet-env-snapshot.env`)
- [ ] `tsc --emitDeclarationOnly` diff for `@pact-network/wrap` shows only additions
- [ ] `grep -rn "createPubSubSink" packages/` returns the new `events.ts` only (call site migrated)
- [ ] `ioredis` in `peerDependenciesMeta` with `optional: true`

### 10.4 Pre-mainnet-deploy gate

Mainnet deploys are `workflow_dispatch` only — the post-adapter image only reaches mainnet when Rick explicitly clicks "Run workflow" → `production`. Before that click, the first time after the PR lands:

- [ ] Inspect `ENV_PROD` GitHub secret. Confirm `QUEUE_BACKEND` is absent AND `REDIS_URL` is absent. If either is present, investigate before deploying.
- [ ] `gcloud run services describe pact-settler --region asia-southeast1 --project pact-network --format='value(spec.template.spec.containers[0].env)'` — confirm no `QUEUE_BACKEND` or `REDIS_*` in runtime env
- [ ] Verify the new image still has `@google-cloud/pubsub` in `node_modules`
- [ ] Add a one-line boot log to settler (temporary): `console.log("queue backend:", env.QUEUE_BACKEND)` — must print `"pubsub"` on mainnet
- [ ] Deploy settler first to canary revision with `--no-traffic`; verify boot; traffic-shift on green
- [ ] Same for market-proxy
- [ ] Indexer + dashboard unaffected — normal deploy path

### 10.5 Mainnet rollback

If post-PR mainnet deploy misbehaves:

```sh
gcloud run services update-traffic pact-settler --region asia-southeast1 \
  --to-revisions <prev-sha>=100
# same for market-proxy if affected
```

Standard rollback. Do **not** revert the PR on `develop` (devnet depends on it). Land a hotfix.

### 10.6 Explicit mainnet non-changes

After this work completes:

- `pact-network` GCP project (224627201825) — untouched
- Cloud Run service names, images, env vars, secret mounts — untouched
- `~/devops/terraform-gcp/pact-network/` — 0 TF resources added/modified
- `ENV_PROD` GitHub secret — untouched
- `INDEXER_PUSH_SECRET` env-var name — preserved (Bug 2 mitigation still active)
- `PACT_SETTLEMENT_AUTHORITY_BS58` Secret Manager secret — untouched
- `pact-settle-events` Pub/Sub topic + `*-settler` subscription + `*-dlq` — untouched
- DNS A records for `api.pactnetwork.io`, `indexer.pactnetwork.io`, `app.pactnetwork.io` — untouched
- LB IP `34.49.161.166` — untouched

### 10.7 Verification after first mainnet deploy

- [ ] `curl -A 'pact-monitor-sdk/0.1.0' https://api.pactnetwork.io/health` → `{"status":"ok","endpoints_loaded":>0}` (Cloud Armor UA bypass per memory `cloud_armor_ua_filter.md`)
- [ ] `curl https://indexer.pactnetwork.io/health` → `{"status":"ok"}`
- [ ] One real wrapped call lands a settle_batch on mainnet Explorer
- [ ] Indexer `/api/stats` increments `calls` by 1
- [ ] Settler logs show `"queue backend: pubsub"`; no `ioredis` warnings; no Pub/Sub regression

If any fail → execute §10.5 rollback.

---

## 11. Risks specific to Railway

| Risk | Mitigation |
|---|---|
| Redis Streams semantics drift from Pub/Sub | Adapter tests against `ioredis-mock`; 1-hour soak before declaring done |
| `peerDeps` change breaks CLI / monitor SDK consumers | `ioredis` declared optional; documented in README |
| Railway credits dry up → service suspended | Auto-recharge or hard cap at $30/mo; project pauses gracefully — no DB/Redis data loss |
| Single-region Railway → higher Solana RPC latency | Pick `asia-southeast1` (matches mainnet); devnet latency is acceptable |
| Custom domain LE provisioning races DNS | Set CNAME first, wait 5 min, then attach custom domain |
| `prisma migrate deploy` partial apply on container kill | Migrations are transactional; safe retry. Cloud SQL socket issue doesn't apply on TCP |
| Settler restart loses unacked Redis messages | `XPENDING` + `XCLAIM` recovers on consumer restart — same durability as Pub/Sub redelivery |
| Railway suspends idle-CPU services | Set `min replicas = 1` on settler |

---

## 12. Settled decisions

- **Branch strategy:** Railway watches `develop` directly. No dedicated `devnet` branch. `develop` is the single source of truth feeding both devnet (auto) and mainnet (manual `workflow_dispatch`). Drift impossible by construction.
- **Settler signer keypair:** reuse existing dev hot key at `~/.config/solana/` (Rick's laptop). Pubkey captured before Railway env setup. **Note:** on mainnet, the settlement authority is a distinct keypair from the program upgrade authority (`pact-settler-sa` runtime SA + `FuT7kRVwHb…` signer vs upgrade auth `JB7rp9wMer…`). Devnet reuses one key for both roles for simplicity — acceptable for devnet, deliberate departure from mainnet's separation. Do not mirror this conflation back to mainnet.
- **Helius API key:** new devnet API key created under the existing Helius project. Same dashboard, separate key, separate analytics + rate limits.
- **Region:** `asia-southeast1` to match mainnet GCP region and minimize RPC RTT delta.

---

## 13. Out of scope

- pact-facilitator service
- Authority rotation to Squads multisig (mainnet concern)
- Observability dashboards beyond Railway built-ins
- Legacy `scorecard` / `backend` / `pact-monitor-backend` migration
- Any mainnet change — this plan is strictly additive

---

## 14. Boundary recap (mirror of §0 for skim-readability)

**Mainnet is on GCP and stays on GCP. Devnet is on Railway. They do not share runtime, secrets, infrastructure, or deployment workflows.**

```
            develop  ←  single source of truth
              │
       ┌──────┴──────┐
       │             │
 auto / push    manual / dispatch
       │             │
       ▼             ▼
    devnet        mainnet
   (Railway)      (GCP, frozen until Rick deploys)
```

Both environments draw from `develop`, but at different cadences: devnet auto-deploys every push; mainnet's image SHA stays frozen until Rick explicitly triggers a `workflow_dispatch` → `production` build. The queue-adapter PR is engineered so mainnet's default code path (`QUEUE_BACKEND` unset) is byte-identical to today's behavior — so even when Rick eventually deploys a post-adapter image to mainnet, behavior is unchanged.

---

## 15. Rejected alternative — full GCP mirror

Earlier draft proposed adding 4 Cloud Run services + Pub/Sub + Cloud SQL DB + 3 LB host rules + 6 Secret Manager secrets to `~/devops/terraform-gcp/staging-apps/` via Flow 3 of the `~/devops` methodology. ~25–30 new Terraform resources, ~$30/mo, full mainnet-identical infrastructure.

Rejected because the GCP topology serves mainnet's reliability requirements, not devnet's. Devnet's job is to catch protocol-level regressions — a code + env + on-chain semantics test, not a Cloud Run scale-to-zero test. The complexity tax did not pay for itself.

Fallback path if Railway proves unsuitable:
- Devnet starts serving real partner integrations and needs mainnet SLOs
- The Redis Streams adapter proves too lossy / divergent
- Railway pricing or reliability becomes unacceptable
