# Rick — Production Setup Checklist (post-2026-05-29 smoke)

What Rick must do to take the multi-network work live, split by surface: **on-chain**, **production DB (Cloud SQL)**, **GCloud services**, plus **code follow-ups**. Tu has no mainnet keys / Cloud SQL / Secret Manager / IAM access (see memory `gcp_ownership`), so everything below is Rick's.

Reference docs: `.planning/endpoint-registration-plan.md` (exact ix shapes), `.planning/endpoints-catalog.md` (provider/chain config), `.planning/smoke/2026-05-29-FULL-smoke-report.html` (today's results).

Key constants verified on mainnet `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` (read-only, 2026-05-29):
- ProtocolConfig authority: `JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL`
- SettlementAuthority.signer (mainnet settler): `FuT7kRVwHbGgLNMULyhxU57VvDVtPMk7UqZT5DDK2ST1`
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` · maxTotalFeeBps 3000 · paused=0
- ProtocolConfig.defaultFeeRecipients: **EMPTY** (each endpoint must carry explicit fee recipients)
- Already registered on mainnet: dummy, helius, pay-default, jupiter, birdeye, elfa, fal. **Missing: moralis, covalent.**

---

## A. ON-CHAIN

### A1. Solana mainnet (5bCJ) — register the 2 new curated providers
- [ ] `register_endpoint` for **moralis** and **covalent** (signer = ProtocolConfig.authority `JB7rp…`). Use `buildRegisterEndpointIx` (packages/protocol-v1-client). Args per provider: slug (16-byte), `flatPremiumLamports`, `percentBps=0`, `slaLatencyMs`, `imputedCostLamports`, `exposureCapPerHourLamports`, and **explicit `feeRecipients`** (the protocol default is empty — copy the split used by the existing endpoints, e.g. treasury `EuptgTib1hFKCngAaJKDdWnWBfZA5if9Q3mjjqrrJV6a` bps 1000 + any affiliate). Requires a pre-allocated 165-byte pool USDC vault per endpoint (see plan A.1 account list).
- [ ] Confirm the chosen production premium/SLA/fee-split values first (see Step D in the registration plan — product decision).

### A2. Solana devnet (5jBQ) — redeploy (bundles 3 things)
- [ ] **Redeploy the current program to devnet** via upgrade authority `47Fg…`. This fixes **FS9** (deployed devnet program predates the `protocol_config` kill-switch → client sends 5 accounts, deployed expects 4 → `InvalidSeeds` on settle). Mainnet is already on the new shape; only devnet drifts.
- [ ] Bundle **SOL-01** (draft PR #245) into the same redeploy: `verify_settlement_authority` PDA+owner check in `settle_batch`. Code-complete; takes effect only after redeploy. Applies to **mainnet too** — schedule a mainnet redeploy via `JB7rp…` when ready (HIGH finding, no fund-theft path, but premium-evasion / batch-DoS / indexer-poison).
- [ ] Before redeploy: verify `ProtocolConfig`/state-struct layout back-compat so existing accounts still decode.

### A3. EVM (arc-testnet + base-sepolia already done in smoke; mainnet EVM = future)
- [ ] Arc/Base **testnet** registrations are already done (today's smoke, via registry authority `0x777d…`). Nothing required unless re-pointing.
- [ ] For any EVM **mainnet** (e.g. base-mainnet 8453, USDC `0x833589fCD6…2913`) — deploy the 3-contract suite + `registerEndpoint` per provider. Not in scope today.

---

## B. PRODUCTION DB (Cloud SQL Postgres)

The indexer's `OnChainSyncService` **auto-creates** the `Endpoint` row (with `upstreamBase` from `DEFAULT_UPSTREAM_BASE`) on the next 5-min sync tick once an endpoint is registered on-chain — so most DB rows need no manual write. Remaining:
- [ ] **Deploy the #247 code** (now on `feat/multi-network`) to the production indexer so `DEFAULT_UPSTREAM_BASE` includes moralis (`deep-index.moralis.io`) + covalent (`api.covalenthq.com`). Without it, those two sync with an empty `upstreamBase`.
- [ ] (Optional) Seed `displayName` / `logoUrl` for any new providers (cosmetic; not auto-synced). Pattern: `packages/db/seeds/dummy-endpoint.ts`. Seeds refuse prod URLs unless `ALLOW_PROD_SEED=1`.
- [ ] After any manual DB change, hot-reload the proxy: `POST /admin/reload-endpoints` with `Authorization: Bearer $ENDPOINTS_RELOAD_TOKEN`.
- [ ] Confirm the prod DB schema is migrated for multi-network (the `Endpoint` composite key `(network, slug)` + per-network config-sync cursor table). Run `prisma migrate deploy` if not already applied.

---

## C. GCLOUD SERVICES (Cloud Run + Secret Manager)

### C1. Secret Manager — provider API keys
- [ ] **`PACT_HELIUS_API_KEY`** — the only provider key the proxy reads from env today (helius injects `?api-key=`). Required for helius to return 200.
- [ ] birdeye / moralis / covalent — currently **caller-passthrough** (caller sends the key header); no proxy secret needed unless you want operator-injected (then needs a code change like C-follow-up).
- [ ] elfa / fal — **need the code follow-up below first**, then provision `PACT_ELFA_API_KEY` / `PACT_FAL_API_KEY` (final env names TBD).

### C2. Cloud Run env — settler + indexer + proxy
- [ ] `PACT_ENABLED_NETWORKS` — include every network you want live (e.g. `solana-mainnet,...`).
- [ ] Per-network RPC URLs the services use (e.g. `PACT_RPC_URL_*`), pointed at production RPC providers (not public endpoints) for the settler/indexer.
- [ ] Settler signer keypairs in Secret Manager: Solana mainnet settler key for `FuT7k…` (the on-chain SettlementAuthority.signer), and `PACT_SETTLER_KEYPAIR_<NETWORK>` (0x-hex) for each EVM network.
- [ ] `ENDPOINTS_RELOAD_TOKEN` (≥16 chars) for the proxy `/admin/reload-endpoints`.
- [ ] Queue/DB env: `QUEUE_BACKEND` + Pub/Sub config (prod uses Pub/Sub, not the redis-streams smoke overlay), `PG_URL` → Cloud SQL, `INDEXER_URL`.
- [ ] Confirm the service Docker images include `@pact-network/shared` + `@pact-network/protocol-evm-v1-client` (PR #225 P0-1 fixed the Dockerfiles — make sure prod rebuilds from current `feat/multi-network`).

---

## D. CODE FOLLOW-UPS (small PRs before certain providers go live)
- [ ] **elfa + fal secret injection** — both handlers strip caller auth but do NOT read an operator key env var (it's a TODO in `elfa.ts` / `fal.ts`). Add `process.env.PACT_ELFA_API_KEY` / `PACT_FAL_API_KEY` injection (Bearer / `Key`). Until then these two cannot return 200.
- [ ] (Optional) If birdeye/moralis/covalent should use a proxy-held key instead of caller-passthrough, same pattern.

---

## D2. VALIDATE the live mainnet settle (loop not yet closed live)
A non-destructive mainnet **simulation** (2026-05-29) proved the settle authorizes + validates against the live `5bCJ` program with a real funded agent (`5XyGG…`, 1.497 USDC, delegate = canonical SettlementAuthority PDA): signer `FuT7k` accepted, ProtocolConfig/not-paused/timestamp/all PDAs/vault+delegate bindings all PASS, agent funds untouched. It was NOT broadcast — two things this box lacks:
- [ ] **`FuT7k` signature** — the mainnet `SettlementAuthority.signer` lives in the pact GCP project's Secret Manager; the dev box's gcloud accounts (`alan@quantum3labs.com`, `devlumilabs@gmail.com`) have **no access** to a pact project. Rick (or `gcloud auth login` as the pact-project owner) is required.
- [ ] **Run one real settle through the production settler** (`SubmitterService`) with the funded `5XyGG` agent against a registered mainnet endpoint (e.g. `dummy`), to close the loop live and rule out the one residual the hand-built sim couldn't isolate (an `InvalidSeeds` at the CPI/`create_account` stage — candidate: `FuT7k` held only 0.0013 SOL, near the call-record rent floor, so **top up the settler signer's SOL** first).

## E. SUGGESTED ORDER
1. Confirm product values (premiums, SLAs, fee splits) for moralis/covalent.
2. Deploy current `feat/multi-network` to prod indexer/settler/proxy (gets the #246 EVM fix + #247 catalog).
3. Provision `PACT_HELIUS_API_KEY` + `ENDPOINTS_RELOAD_TOKEN` + settler keypairs (Secret Manager).
4. `register_endpoint` moralis + covalent on mainnet (with explicit fee recipients).
5. Let the indexer auto-sync the DB rows; verify `/.well-known/endpoints` + `GET /api/endpoints`.
6. Schedule the devnet (+ eventual mainnet) program redeploy bundling FS9 + SOL-01.
7. elfa/fal: ship the secret-injection code change, then provision their keys.
