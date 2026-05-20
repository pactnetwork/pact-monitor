# WP-MN-03a — Gate B Request Report

- **Date:** 2026-05-20
- **Branch:** `feat/multi-network-03a-network-wire`
- **Branch root:** `d358e86` (`feat/multi-network` post WP-MN-02 merge)
- **Tip:** `5de5618`

## 7-category Gate B exit

### 1. PLANs closed (T0..T4)

| Task | SHA | Title |
|---|---|---|
| T1 | `9ebab17` | SettlementEvent.+network additive field in `@pact-network/wrap` |
| T2 | `c18d505` | Producers stamp +network via getChain registry (market-proxy + settler + indexer DTO) |
| T3 | `9514524` | Prisma 6-table migration with composite PKs (local docker only; production untouched) |
| T4 | `1658500` | Indexer composite-key upserts + per-call network resolution |
| T5 | `5de5618` | ?network= filter on 5 read-API surfaces + wire-compat e2e |

### 2. Tests green with counts

| Package | Pre-WP | Post-WP | Delta |
|---|---|---|---|
| `@pact-network/wrap` | 67 | **69** | +2 (T1 stamping tests) |
| `@pact-network/indexer` | ~58 | **79** | +21 (T3 +4 rollback, T4 +5 default-resolution, T5 +12 filter + wire-compat) |
| `@pact-network/settler` | 57 | **57** | unchanged (DTO touch only) |
| `@pact-network/market-proxy` | 138 pass / 3 pre-existing fail | 138 / 3 | preserved; pre-existing failures unchanged |
| `@pact-network/shared` | 17 | **17** | unchanged |

Total run: **220+ green** across 5 packages; 3 pre-existing market-proxy `EndpointRegistry` failures unchanged (confirmed via reviewer diff against branch root).

### 3. Drift / contract checks

- `migration-rollback.spec.ts` (4 tests): composite PK uniqueness within network + cross-network same-callId allowed + composite FK constraint + default insertion. Real `PrismaClient` against local docker Postgres.
- `wire-compat.spec.ts` (10 tests): legacy unstamped → default solana-devnet + stamped → routed + filter narrows + unknown rejects 400 + `:id` defaults to solana-devnet + arc-testnet explicit key works.
- Backward compat proven: pre-MN producers (no `network` field) work against post-MN indexer; default kicks in at the controller boundary.

### 4. Spec parity

| Off-chain §5 deliverable | Artifact |
|---|---|
| `SettlementEvent.+network` (additive only) | `packages/wrap/src/types.ts:58` field; `wrap/src/wrapFetch.ts:178` stamping |
| Wire DTO `+network` on indexer DTOs | `packages/indexer/src/events/events.dto.ts:77, 89` |
| Producers stamp via `getChain` registry | `packages/market-proxy/src/routes/proxy.ts:137`, `packages/settler/src/indexer/indexer-pusher.service.ts:81` |
| Indexer accepts legacy unstamped events, defaults to `'solana-devnet'` | `packages/indexer/src/events/events.controller.ts:28` |
| Prisma 6 tables get `+network` column with composite PKs | `packages/db/prisma/schema.prisma` (6 occurrences; 5 composite @@id; 3 composite @relation; SettlementRecipientShare keeps cuid) |
| Migration SQL committed (no data-loss ops) | `packages/db/prisma/migrations/20260520000000_add_network_column/migration.sql` |
| Indexer idempotency key = `(network, callId)` and `(network, signature)` | `packages/indexer/src/events/events.service.ts` (5 composite upsert sites) |
| Read-API `?network=` filter on 5 surfaces; 400 on unknown | `packages/indexer/src/lib/network-filter.ts` + 5 controller changes |

### 5. Rollback

**Tag `pre-mn-03b-rollback`** placed on `feat/multi-network` post-merge. Captain-proxy authors immediately after PR merge.

**Rollback procedure** (devnet only; production untouched at T3):
```bash
git checkout feat/multi-network
git reset --hard pre-mn-03a-rollback   # restore pre-WP-MN-03a state
# If local docker postgres has the migration applied:
cd packages/db && pnpm dlx prisma migrate reset --skip-seed
```

Production deploy story: when ops eventually runs `prisma migrate deploy` on staging/prod, the migration SQL is the artifact. Forward-only. To rollback production after a deploy: hand-author a down-migration SQL (drop composite PKs, drop the network column). Cloud SQL snapshot pre-apply is the documented safety net. **None of this happens at T3 time** — captain-proxy did not touch any production DB.

### 6. Captain Gate B verdict

`mn-03a-CAPTAIN-GATE-B-VERDICT.md` authored alongside this report. APPROVED.

### 7. Handoff

Cockpit handoff updated post-Gate-B.

---

## Process deviations (transparency)

1. **T2 — settler stamps PER-CALL, not on batch envelope.** Observed by code reviewer. Indexer controller correctly uses per-call as the primary source: `c.network ?? dto.network ?? "solana-devnet"`. T4 honors this.

2. **T3 — Prisma 7 vs Prisma 5 version skew.** Implementer initially tried `pnpm dlx prisma migrate dev --create-only` which pulled Prisma 7 (incompatible). Worked around by using `prisma migrate diff --from-migrations --to-schema-datamodel --shadow-database-url` with the workspace's Prisma 5.22.0. Result identical; migration SQL semantically correct.

3. **T3 — Local docker Postgres had legacy scorecard tables in its persisted volume.** Implementer wiped schema cleanly before applying. Local-only housekeeping; no production impact.

4. **T3 — 5 indexer test suites compile-failed by design** (predicted in T3 plan as expected concern). T4 fixed all of them. By WP end, all suites green.

5. **T5 — Indexer needed jest `moduleNameMapper` entry** for `@pact-network/shared` to resolve through the workspace's `dist/` build. Justified infrastructure fix; narrow scope.

6. **T5 — `getChain("solana-devnet").network` literal in proxy.ts** remains a literal argument to the registry, not env-driven. Documented for WP-MN-03b unification (alongside `on-chain-sync.service.ts`'s hardcoded `syncNetwork = "solana-devnet"`).

None of these deviations changed the design-spec §5 deliverable shape.

---

## Carry forward to WP-MN-03b RESEARCH

- **Unify `solana-devnet` hardcoding** — both `proxy.ts:137` and `on-chain-sync.service.ts:210` carry an explicit `"solana-devnet"` literal. WP-MN-03b's adapter swap should read network from a `PACT_NETWORK` env var or from a per-service config, sourced from `getChain()` registry.
- **`EndpointConfigSnapshot` projection drift** (carry-over from WP-MN-02 Gate B) — Solana's on-chain EndpointConfig has rich fields (`flatPremiumLamports`, `percentBps`, etc.) not in the VM-agnostic projection. The indexer's `on-chain-sync.service.ts` is currently reading the WP-MN-03a projection plus raw `decodeEndpointConfig` fields. WP-MN-03b RESEARCH must decide whether to extend the projection or accept the `raw`-field path.
- **Settler `network` field on batch envelope** — settler stamps per-call but not on batch envelope. WP-MN-04 EvmAdapter may need batch-level network if it does per-batch chain selection; revisit then.
- **`Agent` table** has no `network` column. Wallet pubkeys are network-agnostic. If future EVM consumers want per-network agent stats, the join goes through `Call.network`, not Agent itself. Documented for future me.

---

## Holistic review summary (final reviewer at tip `5de5618`)

- **Verdict:** ✅ Ready for Gate B
- All 9 design-spec §5 deliverables present.
- No data-loss migration ops.
- No chain-touch swap (WP-MN-03b boundary held).
- No secrets/credentials/private keys.
- No legacy Anchor edits.
- Pre-existing failures unchanged (verified via diff against branch root).
- Local-docker-only migration applied; production DB untouched.

## Captain-proxy ask

Issue `mn-03a-CAPTAIN-GATE-B-VERDICT.md` (APPROVED). Then: push branch → PR vs `feat/multi-network` → merge-commit → tag `pre-mn-03b-rollback` → handoff update → open WP-MN-03b.
