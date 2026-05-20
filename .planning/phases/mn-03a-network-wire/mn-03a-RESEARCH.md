# WP-MN-03a — RESEARCH

- **Purpose:** Gate A entry artifact. Enumerates SettlementEvent producers + indexer signature-key consumers, locks the Prisma migration plan + idempotency-key transition + read-API filter semantics, breaks WP-MN-03a into 5 sub-tasks.
- **Companion:** `mn-03a-CONTEXT.md`
- **Branch:** `feat/multi-network-03a-network-wire` off `feat/multi-network@d358e86`
- **Date:** 2026-05-20

---

## 1. Off-chain-spec reference quotes

From `docs/evm/2026-05-19-multi-network-offchain-services-spec.md`:

- **§2.2 (REV1):** "The `SettlementEvent` change is **only additive** — add `+network: string`. **No** `premiumLamports → premiumBaseUnits` rename. **No** `outcome → breach: boolean` collapse. The wire is a one-field expansion; everything else is identity."
- **§2.4:** "Services consume `getChain()` from `@pact-network/shared`/registry (WP-MN-02). No service hardcodes a chain identifier or USDC mint string anymore."
- **§2.6 (REV1):** "Idempotency key for the per-call indexer ingest path migrates from `signature` to `(network, callId)`. EVM tx reorg safety: a `(network, callId)` already in the DB is a duplicate; a same-callId on a different network is NOT a duplicate."

---

## 2. SettlementEvent producer audit

| File | Line | Role |
|---|---|---|
| `packages/wrap/src/types.ts` | 38 | Type definition (single source of truth). |
| `packages/wrap/src/wrapFetch.ts` | 164 | The ONLY production constructor of a `SettlementEvent`. Built per-call right before the EventSink fire-and-forget publish. |
| `packages/wrap/src/eventSink.ts` | 18, 21, 30, 32, 77, 114, 138, 173, 201 | Type imports + EventSink interface uses (publish, store, queue impls). No new fields constructed here. |
| `packages/market-proxy/src/lib/events.ts` | 21, 58 | Re-exports the EventSink type for the proxy's queue publisher. No event construction; the proxy passes through the event built by wrapFetch. |
| `packages/settler/src/submitter/submitter.service.ts` | 67 | Imports `SettlementEvent as ChainSettlementEvent` (note: settler's local type is a different shape — the on-chain ix event, not the wire event). |
| `packages/settler/src/consumer/queue-consumer.interface.ts` | 20 | Comment-only reference. |

**Conclusion:** Only one production constructor (`wrapFetch.ts:164`). One source of truth. Adding `+network` requires:
1. Add field to `SettlementEvent` type at `wrap/types.ts:38`.
2. Add `network` to `WrapFetchOptions` so callers can pass it in.
3. Plumb the value into the event at `wrapFetch.ts:164`.
4. Update `market-proxy` to set `network: 'solana-devnet'` (sourced from `getChain('solana-devnet').network` for the registry-touch).

## 3. Indexer signature-key consumer audit

| File | Line | Role |
|---|---|---|
| `packages/indexer/src/events/events.service.ts` | 168 | `tx.settlement.upsert({ where: { signature: dto.signature } })` — Settlement upsert keyed on signature. Migrate to composite `(network, signature)`. |
| `packages/indexer/src/events/events.service.ts` (around L130–150) | — | `tryInsertCall(tx, call)` — Call insertion deduplicated by P2002 on the `callId` primary key. Migrate to composite `(network, callId)`. |
| `packages/indexer/src/events/events.controller.ts` | 16, 19 | `@Post()` handler accepting `SettlementEventDto`. Add `network` parsing + default-to-`solana-devnet` for legacy events. |
| `packages/indexer/src/events/events.dto.ts` | 75, 122 (approx) | `WrapCallEventDto` + `SettlementEventDto` — add optional `network?: string` to both. |

## 4. Prisma schema diff

### 4.1 Affected models (6)

```prisma
// 1. Endpoint — slug + chain-specific config. (network, slug) becomes the natural composite.
model Endpoint {
  slug    String  @db.VarChar(16)
  network String  @default("solana-devnet") @db.VarChar(24)
  // ... existing fields ...
  @@id([network, slug])
}

// 2. Call — per-call settlement record.
model Call {
  callId  String @db.VarChar(36)
  network String @default("solana-devnet") @db.VarChar(24)
  // ... existing fields including signature ...
  @@id([network, callId])
  @@index([network, agentPubkey, ts(sort: Desc)])
  @@index([network, endpointSlug, ts(sort: Desc)])
}

// 3. Settlement — batch-level.
model Settlement {
  signature String @db.VarChar(88)
  network   String @default("solana-devnet") @db.VarChar(24)
  // EVM tx hash is 0x66-char hex; 88-char VarChar accommodates both.
  // ... existing fields ...
  @@id([network, signature])
}

// 4. SettlementRecipientShare — FK to Settlement.
model SettlementRecipientShare {
  // ... existing fields ...
  network         String @default("solana-devnet") @db.VarChar(24)
  settlement      Settlement @relation(fields: [network, settlementSig], references: [network, signature])
  @@index([network, recipientPubkey])
}

// 5. PoolState — per-endpoint.
model PoolState {
  endpointSlug String @db.VarChar(16)
  network      String @default("solana-devnet") @db.VarChar(24)
  // ... existing fields ...
  @@id([network, endpointSlug])
  endpoint Endpoint @relation(fields: [network, endpointSlug], references: [network, slug])
}

// 6. RecipientEarnings — per-recipient.
model RecipientEarnings {
  recipientPubkey String @db.VarChar(44)
  network         String @default("solana-devnet") @db.VarChar(24)
  // ... existing fields ...
  @@id([network, recipientPubkey])
}
```

`Agent` is NOT in the migration set — an agent's pubkey is wallet-identity, network-agnostic. (Solana base58 and EVM 0x-hex have different formats, and the same wallet won't exist on both. The Agent's per-network activity rolls up via Call → agent FK.)

### 4.2 Migration strategy

**Forward migration steps (single Prisma migration file):**
1. Add `network String @default("solana-devnet") @db.VarChar(24)` to all 6 models — Prisma generates `ALTER TABLE ADD COLUMN`.
2. Backfill: the `@default("solana-devnet")` handles this automatically for the column-add — Postgres applies the default to all existing rows in the same DDL transaction.
3. Drop old single-column `@id` constraints; add composite `@@id([network, X])`. Prisma generates `ALTER TABLE DROP CONSTRAINT ... PRIMARY KEY ...; ADD PRIMARY KEY (network, X);`.
4. Update existing `@@index` lists to be `network`-prefixed where the query path filters by network.

**Down migration (reversible) steps:**
1. Drop composite `@@id`; restore single-column `@id`.
2. Drop the `network` column.

The down-migration test in CI:
- Spin up a Postgres test DB
- Apply migration forward
- Insert sample data (1 row per affected table)
- Apply migration backward
- Confirm data integrity (other columns preserved; row count unchanged)
- Apply forward again
- Confirm rows now have `network='solana-devnet'`

**Cloud SQL snapshot pre-apply** (production cutover): captain-proxy step at WP-MN-03a Gate B, NOT in the migration file itself. Documented in the Gate B runbook.

### 4.3 Idempotency-key transition

The transition window risk: while the migration is running, the indexer briefly has BOTH idempotency keys live (old single-column unique on `signature`/`callId`, new composite). The transition is safe because:

1. Prisma migration applies forward in ONE transaction → no observable intermediate state.
2. Backfill default of `'solana-devnet'` means every existing row has the SAME network value → composite `(solana-devnet, callId)` is unique iff `callId` was unique before. No false-positive duplicates.
3. The service code (events.service.ts) is updated in the same commit to query by composite — no race with the schema.

The risk surface: between PR merge and production deploy, the DB has the new schema but old service code is still running. The old code's `where: { signature }` query would fail with "unknown field" since Prisma's generated client expects composite. **Mitigation:** deploy strategy is "migrate → re-deploy services in lockstep." The CI gate runs prisma migrate + service tests together; production deploy is single-PR.

---

## 5. RESEARCH-time decisions

### 5.1 `network` column type — `String @db.VarChar(24)`

24 chars is enough for `"solana-mainnet-beta"` (19) + headroom. EVM names like `"arc-testnet"` (11), `"base-mainnet"` (12) fit. No chain identifier is longer than 24 chars in `chains.json` (max is `"solana-mainnet"` = 14).

### 5.2 `Settlement.signature` column width

Currently `@db.VarChar(88)` (Solana base58 ed25519 signature). EVM tx hash is `0x` + 64 hex = 66 chars. 88 accommodates both. No change to width.

### 5.3 `Endpoint.slug` composite-key change

Adding `(network, slug)` composite breaks the single-column FK references from `Call.endpointSlug`, `PoolState.endpointSlug`. Migration must update FK constraints to reference the composite. Prisma generates this from the `@relation` directive.

### 5.4 Read-API `?network=` semantics

- **Default:** no `?network=` query param → aggregate across networks (existing behavior preserved).
- **Filter:** `?network=arc-testnet` → narrow to that network. Throws 400 if the value isn't in `listChains()` (so typos surface loudly).
- **Aggregate-with-grouping:** future enhancement to `/api/stats?groupBy=network` — out of scope for WP-MN-03a.

### 5.5 wrapFetch `network` plumbing

Add `network?: string` to `WrapFetchOptions`. wrapFetch defaults to `'solana-devnet'` if absent (backward compat for any external consumer). market-proxy passes the value explicitly.

### 5.6 Settler ingest path

The settler's `submitter.service.ts` reads `SettlementEvent`s from the queue, builds the indexer-DTO superset (`WrapCallEventDto`), and POSTs to indexer's `/events`. It must propagate the incoming event's `network` into the outgoing DTO. If the incoming event lacks `network` (legacy), default to `'solana-devnet'`.

---

## 6. Sub-task breakdown (PLAN files)

| PLAN | Title | Files touched | Tests |
|---|---|---|---|
| `mn-03a-01-PLAN.md` | SettlementEvent wire change + wrap+SDK stamping | `packages/wrap/src/types.ts`, `packages/wrap/src/wrapFetch.ts` (add `network` to WrapFetchOptions, plumb to event), `packages/wrap/__tests__/wrapFetch.test.ts` (new test: explicit network gets stamped; absent network defaults to solana-devnet) | wrap unit tests +2 |
| `mn-03a-02-PLAN.md` | Registry consumed by proxy + settler + indexer | `packages/market-proxy/src/lib/events.ts` (stamp via `getChain('solana-devnet').network`), `packages/settler/src/submitter/...` (propagate event.network into outgoing DTO; default to 'solana-devnet' for legacy events), `packages/indexer/src/events/events.dto.ts` (add `network?: string` to both DTOs) | proxy + settler + indexer unit tests +3 |
| `mn-03a-03-PLAN.md` | Prisma migration + backfill + down-migration CI test | `packages/db/prisma/schema.prisma` (6 model edits + 5 composite-key changes), Prisma migration generated, `packages/indexer/test/migration-rollback.test.ts` (CI test exercising forward+backward) | indexer migration tests +1 |
| `mn-03a-04-PLAN.md` | Indexer idempotency-key composite-query update + ingest-path network default | `packages/indexer/src/events/events.service.ts` (Settlement upsert composite where; Call insert composite where; events.controller.ts default network='solana-devnet' for unstamped) | indexer ingest tests +2 |
| `mn-03a-05-PLAN.md` | Read-API `?network=` filter on 5 controllers + end-to-end wire-compat test | `packages/indexer/src/{stats,api/calls,api/endpoints,api/agents}/...controller.ts` (5 controllers gain `?network=` query param), `packages/indexer/test/wire-compat.e2e.test.ts` (pre-03a settler against post-03a indexer; post-03a settler against pre-03a indexer — both work) | indexer read-API + wire-compat tests +6 |

---

## 7. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Live indexer Prisma migration drops rows or violates a constraint (PR-R1 in plan-level register) | Down-migration test in CI runs forward+backward against a seeded test DB; PR is gated on test green. Production deploy includes Cloud SQL snapshot pre-apply (documented in Gate B runbook, not in code). |
| R2 | Composite-key changes break FK constraints on Call→Endpoint, PoolState→Endpoint, SettlementRecipientShare→Settlement | Prisma's `@relation(fields: [network, slug], references: [network, slug])` generates the composite FK. CI test verifies referential integrity post-migration. |
| R3 | Settler running pre-WP-MN-03a code emits events without `network`; post-WP indexer rejects them | Indexer accepts optional `network`; defaults to `solana-devnet` for legacy events. Mn-03a-05 wire-compat e2e test exercises this. |
| R4 | Idempotency-key change creates a brief window where same-callId on multiple networks isn't deduplicated correctly | Composite-key constraint added in same migration as the column; backfill default ensures all existing rows have `network='solana-devnet'`, so the composite is unique iff callId was unique before. No race. |
| R5 | Read-API `?network=` filter on `/api/stats` is harder to retrofit than expected (existing aggregate logic may not parameterize cleanly) | Mn-03a-05 PLAN includes a "stats controller filter behavior" step that EXPLICITLY tests the default-aggregate vs filter paths. |
| R6 | Existing tests on indexer break because mocked DB rows lack `network` field | Mn-03a-04 PLAN's first step regenerates Prisma client + runs the test suite; fixes any test fixture that needs `network` added. |

---

## 8. Open questions

- **None blocking.** WP-MN-04 will populate real `network` values for Arc Testnet on chains.json; this WP only handles the `solana-devnet` case.

---

## 9. Gate A request

This RESEARCH + the companion CONTEXT satisfy the Gate A entry criteria. **Captain (Tu / captain-proxy): please emit `mn-03a-CAPTAIN-GATE-A-VERDICT.md`.** On APPROVED, next step is to author 5 PLAN files via `superpowers:writing-plans` + execute via `superpowers:subagent-driven-development`.
