# Multi-Network LIVE Smoke Report — 2026-05-29 (post PR #225 P0 fixes)

- **Branch / HEAD:** `feat/multi-network` @ `f538749` (the 4 P0 fixes for PR #225)
- **Operator:** captain-delegated crew (local pnpm workspace)
- **Working dir:** `/Users/q3labsadmin/Q3/Solder/pact-network`
- **Goal:** re-verify all three chain adapters (solana-devnet, base-sepolia, arc-testnet) end-to-end after the P0 changes, mirroring the 2026-05-28 GREEN run's method exactly.
- **Prior GREEN run mirrored:** `.planning/smoke/2026-05-28-multi-network-LIVE-fullsmoke-REPORT.md`
- **Logs:** `.planning/smoke/logs/{indexer,proxy,settler}-529.log`, `solcall-529.log`, `settle-green-529.log`, `harness-529.log`, `mixedbatch-529.log`
- **Harnesses (test-only, uncommitted):** reused `.planning/smoke/{solcall-528,harness-528}.mjs`; created `.planning/smoke/settle-green-529.mjs` (4-account settle driver, new callId; uses client `deriveAssociatedTokenAccount` instead of `@solana/spl-token` for clean ESM resolution).

## Top-level verdict: **GREEN** — no P0 regression on any chain; real on-chain `settle_batch` re-captured on devnet.

The 4 P0 fixes (commits `3cc0c8f`/`f6a1531`/`b3c99f7`/`f538749`) introduced **no regression** to the multi-network closed loop. All three adapters bootstrap cleanly in both settler and indexer (`legacyDirectSolana=false`); the Solana premium charge → Redis → on-chain `settle_batch` GREEN path still lands with the correct fee split; the base-sepolia EVM EIP-191 verify → wrap → zero-premium skip path is unchanged; arc-testnet remains a clean SKIP (empty `upstreamBase`). The three P0-specific checks (chains baked-const, EVM case-normalize verify + cross-VM reject, settler secret redaction) all pass. **FS9** (deployed `5jBQ` predates the `protocol_config` kill-switch) reproduced exactly as on 5/28 — a **pre-mainnet redeploy blocker, not a P0 regression**.

| Chain | Step(s) | Result | Verdict |
|-------|---------|--------|---------|
| **solana-devnet** | 1,2,3,6 | 3/3 services healthy; premium 1000 charged; **`settle_batch` finalized on devnet** (sig below); agent −1000 / pool +900 / treasury +100; CallRecord PDA created | **GREEN** |
| **base-sepolia** | 1,2,4,6 | EIP-191 mixed-case addr verified → upstream 401 → `client_error` premium=0 → settler `Skipping zero-premium` | **GREEN (no regression)** |
| **arc-testnet** | 1,2,5 | adapter bootstraps + live EVM signer balance polled; endpoint `upstreamBase` empty → `501 no handler` | **SKIP** (operator data, out of scope) |

| Step | Result | Verdict |
|------|--------|---------|
| 1 — Boot (indexer + proxy + settler, redis-streams overlay) | 3/3 healthy; settler & indexer both log `adapters bootstrapped: solana-devnet, base-sepolia, arc-testnet \| legacyDirectSolana=false` | PASS |
| 2 — Endpoint sync | 4 rows across 3 networks; premiums configured (`flatPremiumLamports`: dummy/helius=1000, arc e2e=10000); proxy `endpoints_loaded=4` | PASS |
| 3 — **Solana premium charge + on-chain settle** | **non-zero premium charged**, event in Redis, **`settle_batch` finalized on devnet** (sig below); agent −1000 / pool +900 / treasury +100; CallRecord PDA created | **PASS (GREEN)** |
| 4 — EVM closed loop (base-sepolia) | EIP-191 verify → wrap → redis (`network=base-sepolia`) → settler `Skipping zero-premium … client_error` | PASS (no regression) |
| 5 — arc-testnet | empty `upstreamBase` → `501 no handler for endpoint` | SKIP (operator data, out of scope) |
| 6 — Mixed-batch partition | two distinct `(network, slug)` flush groups, isolated from siblings | PASS |
| 7 — Cross-VM auth guard | 4/4 probes verbatim-match prior | PASS |

---

## Environment / pre-flight

```
$ git rev-parse --short HEAD                       → f538749 (feat/multi-network, clean tree apart from .planning/*)
$ docker start pact-redis-smoke                     → redis up on :6380
$ solana balance 47Fg… --url devnet                 → 2.020 SOL (settler Solana signer; = upgrade authority)
$ solana-keygen pubkey …/settlement-authority.json  → 47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS
```

Services booted from freshly-built `dist/` (all 7 packages built clean: `shared`, `protocol-v1-client`, `protocol-evm-v1-client`, `wrap`, `settler`, `indexer`, `market-proxy`). Overlay for all three (command-line only, **no env-file edits**): `QUEUE_BACKEND=redis-streams REDIS_URL=redis://localhost:6380 REDIS_STREAM=pact-settle-events`. Settler additionally given `PACT_SETTLER_KEYPAIR_SOLANA_DEVNET=<47Fg settlement-authority.json byte-array>` (top priority in `loadKeypair`) so the adapter settle path signs as the on-chain-authorized `47Fg` (resolves FS8 by alignment, same as 5/28).

### Environment deviations (this run only — non-destructive, Tu-approved)
1. **Postgres on host port 5434, not 5433.** `pact-pg`'s native port 5433 was held by an unrelated active project's DB (`oneplan-postgres`). Per Tu's choice, started a throwaway `postgres:16-alpine` (`pact-pg-529`) on **5434** mounting the **same `pact-network_pgdata` volume** (all prior Endpoint rows intact), and overlaid `PG_URL=postgresql://pact:pact@localhost:5434/pact` on indexer + proxy (command-line only). `oneplan-postgres` was never touched.
2. **Indexer on port 3012, not 3002.** Port 3002 was held by another project (OnePlanApp server). Overlaid indexer `PORT=3012` and settler `INDEXER_URL=http://localhost:3012` (command-line only).
3. **ESM harness resolution.** `.planning/smoke/*.mjs` import bare specifiers (`bs58`, `viem`, `@solana/web3.js`, the v1 client) that don't resolve from `.planning/smoke/` (no node_modules there). Ran each harness from a transient copy inside the owning package dir (`packages/market-proxy` for solcall/EVM, `packages/protocol-v1-client` for the settle driver), removed after. No package source touched.

---

## Step 3 — Solana premium charge + on-chain settle: **GREEN**

### Signed call (raw ed25519 → proxy; `solcall-528.mjs dummy`)
`POST /v1/dummy/` with `x-pact-network: solana-devnet`, ed25519-signed v2 payload, body = `getBalance`. Upstream `200` → classifier `ok` → flat 1000-lamport premium. Event published to Redis:
```
{"callId":"cea75b3a-1b01-4dca-87cd-b64d785598e8","agentPubkey":"Hr7XX…","endpointSlug":"dummy",
 "premiumLamports":"1000","refundLamports":"0","latencyMs":55,"outcome":"ok",
 "ts":"2026-05-29T04:38:57.792Z","network":"solana-devnet"}
```
Proxy response headers: `x-pact-premium=1000`, `x-pact-outcome=ok`, `x-pact-call-id=cea75b3a…`, `x-pact-settlement-pending=1`.

### Settler's own flush (expected FS9 failure)
The settler picked up `cea75b3a…` and attempted its canonical **5-account** `settle_batch` ix; deployed `5jBQ` rejected with `Provided seeds do not result in a valid address` (`InvalidSeeds`). **This is FS9, reproduced exactly as on 5/28 — known/expected on devnet, not a P0 regression.**

### On-chain `settle_batch` (GREEN capture, signed by `47Fg`, devnet program `5jBQ`)
Same fired event (`cea75b3a…`) settled on-chain via the deployed program's **4-account** layout (FS9 workaround, `settle-green-529.mjs`). Finalized, `err: null`, 16139 CU. Verified token-balance deltas:

| Account | Before | After | Δ |
|---------|--------|-------|---|
| agent USDC ATA | 19999000 | 19998000 | **−1000** (premium debited via SettlementAuthority delegate) |
| pool vault | 1000900 | 1001800 | **+900** (premium in 1000, fee out 100, residual stays) |
| treasury vault | 100 | 200 | **+100** (10% treasury cut, `bps=1000`) |
| CallRecord PDA `JAVozy3T…` | absent | created (owner `5jBQ`) | dedup sentinel written |

`$ solana confirm 4Gksg… → Finalized`. Fee split identical to the 5/28 GREEN run.

## Step 4 — base-sepolia EVM closed loop: **GREEN (no regression)**

Real EIP-191 v2-signed `POST /v1/helius/` (`harness-528.mjs step4`), signer EOA `0x1c84b6c482d480Ec6F8911fd5A25305B40124760` (mixed-case): `HTTP 401` (upstream missing-api-key), `outcome=client_error`, `premium=0`, `x-pact-call-id=0e93b7ac…`. Event in Redis with `network=base-sepolia`; settler: `Skipping zero-premium event 0e93b7ac… outcome=client_error`. Identical to prior runs. The signature **verified** (request reached upstream), which directly exercises the P0-3 EVM address case-normalize path on a real mixed-case address.

## Step 5 — arc-testnet: **SKIP**
Adapter bootstraps and the arc-testnet EVM gas signer balance is polled live (`19.15 native`). Endpoint `e2e-test-slug-01` has empty `upstreamBase` → proxy returns `501 {"error":"no handler for endpoint"}`. Operator data, scoped out (unchanged from 5/28).

## Step 6 — mixed-batch partition: **PASS**
Fired one solana-devnet call (`e1d2d603…`, premium 1000) + one base-sepolia call (`f847c760…`, premium 0) into the same batch window. The batcher partitioned them into distinct flush groups, isolated from siblings:
- `["solana-devnet","dummy"]` → settle attempt (settler 5-account ix → FS9 `InvalidSeeds`; the on-chain GREEN settle for this network is captured via the 4-account path in Step 3)
- base-sepolia zero-premium → `Skipping zero-premium event f847c760…`

## Step 7 — cross-VM auth guard: **PASS**
```
Probe 1 solana-devnet + EVM agent  → "agent key type (evm) does not match endpoint network solana-devnet"
Probe 2 arc-testnet  + Solana agent → "agent key type (solana) does not match endpoint network arc-testnet"
Probe 3 solana-devnet + Solana agent → "malformed signature or pubkey"   (negative control)
Probe 4 base-sepolia + EVM agent     → "signature verification failed"    (negative control)
```
Verbatim-match to the 5/28 run. Source: `packages/market-proxy/src/middleware/verify-signature.ts`.

---

## EXTRA P0-focused checks (what changed since 5/28)

| Check | Method | Result |
|-------|--------|--------|
| **P0-2 — EVM chain table baked into TS const (no `readFileSync(chains.json)` at runtime)** | Inspected built `packages/shared/dist/chains.js`: chain table is an inline object literal (`arc-testnet`/`base-sepolia` entries); the only `readFileSync` token is an explanatory comment stating the JSON does **not** ship/read at module-load. No `fs`/`require`/JSON-import in the dist. All 3 adapters bootstrap clean in **both** settler + indexer, with live EVM signer-balance polls on base-sepolia + arc-testnet — runtime proof the const resolves. | **PASS** |
| **P0-3 — EVM address case-normalize verify still verifies a real EIP-191 v2 call AND cross-VM guard still rejects** | Step 4: real mixed-case EOA `0x1c84…4760` EIP-191 signature **verified** (reached upstream). Step 7: 4/4 cross-VM probes reject verbatim. | **PASS** |
| **P0-4 — settler secret redaction (no raw keypair/secret in boot/error logs)** | Grepped `settler-529.log` for the settlement-authority key's leading byte sequence (`36,34,6,81,81,191`), `secretKey`, base58/byte-array secret patterns: **none found**. Clean boot (no keypair-parse error path triggered); the parse-error path (`adapters.service.ts:192-194`) logs only `(e as Error).name` by construction. | **PASS** |

---

## Tx-hash table

| Signature | Network | Role | Notes |
|-----------|---------|------|-------|
| `4GksgECCXJn2h8inYxazuoSGuPFEDXnrLYrmHaQTzhKBJjzA2rpBG5rS1gSQNp5owZBwtWbiyQcBHw7P4CrMgsfp` | solana-devnet | **settle_batch (GREEN)** | Finalized. Settled real fired call `cea75b3a…` under `5jBQ`, signed by `47Fg`. agent −1000 / pool +900 / treasury +100; CallRecord `JAVozy3T…` created. 4-account layout (FS9 workaround). solscan: `…?cluster=devnet` |
| — | base-sepolia | settle_batch | none owed (zero-premium `client_error`) |
| — | arc-testnet | settle_batch | none owed (SKIP, empty `upstreamBase`) |

---

## Findings

| ID | Title | Status |
|----|-------|--------|
| **FS6** | Adapter Solana signer env mismatch. | **FIXED — PR #244** (no regression this run; settler signer overlay resolves cleanly) |
| **FS7** | Adapter program-id drift (fell back to client mainnet `PROGRAM_ID`). | **FIXED — PR #244** (no regression; GREEN settle under `5jBQ`) |
| **FS8** | On-chain settler-authority is `47Fg` (not `H8pL`). | **RESOLVED by alignment** — settler signs `settle_batch` as `47Fg` via `PACT_SETTLER_KEYPAIR_SOLANA_DEVNET` overlay (same as 5/28). |
| **FS9** | **Deployed-program / client account-layout drift.** Deployed devnet `5jBQ` (2026-05-05) predates the `protocol_config` kill-switch that current `settle_batch.rs` added as fixed account #4. Current `buildSettleBatchIx` emits **5** fixed accounts; deployed program expects **4** → `InvalidSeeds` on the settler's real flush. The 4-account driver lands the GREEN tx. | **OPEN — pre-mainnet blocker (NOT a P0 regression).** Reproduced identically to 5/28. Fix = redeploy current program source to devnet (and mainnet `5bCJ`) so the on-chain program matches the client/settler. Before redeploy, verify `ProtocolConfig`/state-struct layout compatibility. Note: SOL-01 fix (draft PR #245) is part of the same pending redeploy. |
| **FS5** | `pact` CLI has no devnet cluster support. | **OPEN — follow-up PR** (worked around: raw signed HTTP + hand-rolled settle driver with explicit devnet mint). |

---

## What I did NOT do
- **No source-code edits.** Only `.planning/smoke/` test harnesses created/copied.
- **No program redeploy** (FS9 fix). GREEN captured via the deployed program's 4-account layout, same as 5/28.
- **No env-file edits / no env commits.** All overlays command-line only.
- **No signer funding / no closed-loop beyond the 5/28 GREEN run.** Stayed at the on-chain settlement layer the prior report verified (indexer ingest of the GREEN settle is gated behind the settler's FS9 flush and is intentionally not chased here).
- **Did not touch `oneplan-postgres`** (the unrelated project's DB on 5433). Used a separate temp container on 5434 with the same data volume.
- **No `PACT_LEGACY_DIRECT_SOLANA`** (`legacyDirectSolana=false` throughout).
- **No commits / no push / no merge.**

## Teardown note
Smoke services (indexer pid, proxy pid, settler pid) and the temp `pact-pg-529` container are torn down at end of run; `pact-redis-smoke` left as-is (shared smoke infra). `oneplan-postgres` untouched throughout.
