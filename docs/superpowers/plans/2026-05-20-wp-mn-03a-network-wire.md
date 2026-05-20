# WP-MN-03a — `+network` Wire + DB Column — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the off-chain pipeline multi-network-aware on the wire and in storage — purely additively. No chain-touch swap (that's WP-MN-03b).

**Architecture:** Five sub-tasks in dependency order: (T1) `SettlementEvent.+network` in `@pact-network/wrap`; (T2) market-proxy + settler + indexer DTO stamp; (T3) Prisma 6-table migration with composite `(network, X)` primary keys + reversible down-migration tested in CI; (T4) indexer ingest idempotency composite-key update + default-to-`solana-devnet` for legacy events; (T5) read-API `?network=` filter on 5 endpoint surfaces + wire-compat e2e test.

**Tech Stack:** TypeScript / Prisma / Postgres / NestJS / Vitest / pnpm workspaces. No new deps.

**Branch:** `feat/multi-network-03a-network-wire` (off `feat/multi-network@d358e86` post WP-MN-02).

**Captain-proxy directives** (from `mn-03a-CAPTAIN-GATE-A-VERDICT.md`):
- Atomic commits per task, conventional-commit prefixes.
- NO remote pushes until Gate B closes.
- **HIGHEST RISK: T3 Prisma migration.** CI down-migration test is the gate.
- Pause-and-escalate (BLOCKED) on RESEARCH-contradicting findings.

**Source-of-truth references:**
- CONTEXT: `.planning/phases/mn-03a-network-wire/mn-03a-CONTEXT.md`
- RESEARCH: `.planning/phases/mn-03a-network-wire/mn-03a-RESEARCH.md` (esp. §2 producer audit, §3 idempotency-key audit, §4 Prisma diff)

---

## Task 1: `SettlementEvent.+network` in `@pact-network/wrap`

**Goal:** Add the `network?: string` field to the `SettlementEvent` type and the `WrapFetchOptions`. Plumb the value into wrapFetch's event construction. Default to `'solana-devnet'` when caller doesn't specify.

**Files:**
- Modify: `packages/wrap/src/types.ts` (add `network?: string` to `SettlementEvent`)
- Modify: `packages/wrap/src/wrapFetch.ts` (add `network?: string` to options; stamp event at line ~164)
- Add: `packages/wrap/__tests__/network-stamping.test.ts` (new tests for the stamping)

- [ ] **Step 1: Baseline**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/wrap test 2>&1 | tail -5
```

Record the count.

- [ ] **Step 2: Add `network` to `SettlementEvent` type**

Edit `packages/wrap/src/types.ts:38` — append `network?: string` to the interface:

```typescript
export interface SettlementEvent {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  /** bigint as decimal string, e.g. "1000". */
  premiumLamports: string;
  /** bigint as decimal string. */
  refundLamports: string;
  latencyMs: number;
  outcome: Outcome;
  /** ISO-8601 timestamp of when the wrapped call completed. */
  ts: string;
  /**
   * Network identifier (WP-MN-03a). Optional during the migration window;
   * consumers default to `'solana-devnet'` when absent so legacy pre-MN
   * settlers can still publish events.
   *
   * Values come from `getChain(name).network` in `@pact-network/shared`.
   * Examples: "solana-devnet", "solana-mainnet", "arc-testnet".
   */
  network?: string;
}
```

- [ ] **Step 3: Add `network` to WrapFetchOptions**

Open `packages/wrap/src/wrapFetch.ts`. Find the `WrapFetchOptions` interface (or equivalent — usually near the top of the file or in a co-located types file). Add:

```typescript
  /**
   * Network identifier stamped onto SettlementEvent (WP-MN-03a). Optional;
   * defaults to "solana-devnet" if not provided. Callers using the network
   * registry pass `getChain(name).network`.
   */
  network?: string;
```

Then at line ~164 where the event is constructed, add the network field:

```typescript
  const event: SettlementEvent = {
    callId,
    agentPubkey: opts.walletPubkey,
    endpointSlug: opts.endpointSlug,
    premiumLamports: classified.premium.toString(),
    refundLamports: classified.refund.toString(),
    latencyMs,
    outcome: classified.outcome,
    ts: new Date(tEnd).toISOString(),
    network: opts.network ?? "solana-devnet",
  };
```

- [ ] **Step 4: Write tests for the stamping**

Create `packages/wrap/__tests__/network-stamping.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { wrapFetch } from "../src/wrapFetch";
import type { SettlementEvent } from "../src/types";

// Read existing wrapFetch tests to find the test fixture pattern (probably
// a stub EventSink + stub fetch). Mirror that pattern; if a shared helper
// exists, reuse it.

describe("WP-MN-03a — SettlementEvent network stamping", () => {
  it("stamps the configured network on the published event", async () => {
    const captured: SettlementEvent[] = [];
    const sink = {
      publish: async (event: SettlementEvent) => {
        captured.push(event);
      },
    };
    // ... construct wrapFetch options with sink + network: "arc-testnet"
    // ... call wrapFetch with a passing classifier
    // ... await the publish promise
    // expect(captured[0].network).toBe("arc-testnet");
  });

  it("defaults to 'solana-devnet' when network is not specified", async () => {
    const captured: SettlementEvent[] = [];
    const sink = {
      publish: async (event: SettlementEvent) => {
        captured.push(event);
      },
    };
    // ... no network in options
    // expect(captured[0].network).toBe("solana-devnet");
  });
});
```

NOTE: Use the existing wrapFetch test helpers — read `packages/wrap/__tests__/` to find them. If no helper exists, inline the stub setup (likely needs a stub fetch returning a 200 + a stub classifier returning `{ premium, refund, outcome: 'ok' }`).

- [ ] **Step 5: Verify**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/wrap test 2>&1 | tail -10
pnpm --filter @pact-network/wrap typecheck 2>&1 | tail -5
pnpm --filter @pact-network/wrap build 2>&1 | tail -5
```

Expected: prior baseline + 2 new tests, all green.

- [ ] **Step 6: Commit**

```bash
git add packages/wrap/
git commit -m "feat(wrap): SettlementEvent.+network additive field (WP-MN-03a T1)

Adds optional 'network' field to SettlementEvent and plumbs it
through WrapFetchOptions. Pure additive — defaults to
'solana-devnet' for backward compat with pre-MN settlers.

Per off-chain spec §2.2 REV1: only +network changes. No
premiumLamports rename, no outcome→breach collapse.

Test count: +2 in @pact-network/wrap."
```

---

## Task 2: market-proxy + settler + indexer DTO stamp `network`

**Goal:** Wire the producers (market-proxy via wrap, settler propagating events) to set the network field. Indexer DTO accepts the field. No DB / migration here — that's T3.

**Files:**
- Modify: `packages/market-proxy/src/lib/events.ts` (or wherever the proxy constructs wrap options) — pass `network: 'solana-devnet'` sourced from `getChain('solana-devnet').network`
- Modify: `packages/market-proxy/package.json` — add `@pact-network/shared` workspace dep (for `getChain`)
- Modify: `packages/settler/src/submitter/submitter.service.ts` (or wherever the settler builds the outgoing `WrapCallEventDto`) — propagate `event.network ?? 'solana-devnet'` into the DTO
- Modify: `packages/indexer/src/events/events.dto.ts` — add `network?: string` to `WrapCallEventDto` and `SettlementEventDto`

- [ ] **Step 1: market-proxy stamps via getChain**

Read `packages/market-proxy/src/lib/events.ts` to find where wrap is invoked. Read the `WrapFetchOptions` construction site. Add:

```typescript
import { getChain } from "@pact-network/shared";

// In the wrap options:
network: getChain("solana-devnet").network, // sourced from registry, not hardcoded
```

Update `packages/market-proxy/package.json` to add `"@pact-network/shared": "workspace:*"` in dependencies.

Run:
```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm install 2>&1 | tail -5
```

- [ ] **Step 2: settler propagates network**

Read `packages/settler/src/submitter/submitter.service.ts` and find where `WrapCallEventDto` (the outgoing indexer push body) is built. There's likely a function constructing it from incoming `SettlementEvent`s. Add:

```typescript
network: incomingEvent.network ?? "solana-devnet",
```

into the DTO construction.

- [ ] **Step 3: indexer DTO accepts `network`**

Edit `packages/indexer/src/events/events.dto.ts`:

```typescript
export interface WrapCallEventDto {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  outcome: SettlementOutcome;
  source?: string;
  payee?: string;
  resource?: string;
  ts: string;
  settledAt: string;
  signature: string;
  shares: RecipientShareDto[];
  /**
   * Network identifier. Optional during MN migration; indexer defaults to
   * 'solana-devnet' for legacy unstamped events.
   */
  network?: string;
}

export interface SettlementEventDto {
  signature: string;
  batchSize: number;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  ts: string;
  calls: WrapCallEventDto[];
  /** Network identifier for the batch. Falls back to per-call network or
   * 'solana-devnet'. */
  network?: string;
}
```

- [ ] **Step 4: Verify cross-package**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm install 2>&1 | tail -3
pnpm --filter @pact-network/market-proxy typecheck 2>&1 | tail -5
pnpm --filter @pact-network/settler typecheck 2>&1 | tail -5
pnpm --filter @pact-network/indexer typecheck 2>&1 | tail -5
pnpm --filter @pact-network/market-proxy test 2>&1 | tail -5
pnpm --filter @pact-network/settler test 2>&1 | tail -10
pnpm --filter @pact-network/indexer test 2>&1 | tail -10
```

Expected: all green. Existing tests preserved.

- [ ] **Step 5: Commit**

```bash
git add packages/market-proxy/ packages/settler/ packages/indexer/ pnpm-lock.yaml
git commit -m "feat(off-chain): producers stamp +network via getChain registry (WP-MN-03a T2)

market-proxy stamps SettlementEvent.network='solana-devnet' (sourced
from getChain registry, not a hardcoded constant).
settler propagates incoming event.network into the outgoing
WrapCallEventDto with solana-devnet fallback for legacy events.
indexer DTOs accept network as an optional field on both
WrapCallEventDto and SettlementEventDto.

No DB migration here — that's T3. No chain-touch swap — that's WP-MN-03b.

Added @pact-network/shared as a runtime dep of market-proxy."
```

---

## Task 3: Prisma migration — 6 tables get `network` + composite PKs

**Goal:** Add `network` column + composite primary keys to 6 Prisma models. Backfill all existing rows to `'solana-devnet'`. Down-migration tested in CI.

**HIGHEST RISK TASK.** Pause-and-escalate on any unexpected behavior.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Generate: `packages/db/prisma/migrations/<timestamp>_add_network_column/migration.sql`
- Create: `packages/indexer/test/migration-rollback.test.ts` (CI gate)

- [ ] **Step 1: Read current schema completely**

```bash
cat packages/db/prisma/schema.prisma
```

Confirm the 6 affected models match RESEARCH §4.1. If any field is different from RESEARCH's table, PAUSE and surface as BLOCKED — RESEARCH must be amended first.

- [ ] **Step 2: Edit schema.prisma — apply RESEARCH §4.1 diff**

Update each of the 6 models per RESEARCH §4.1. Key changes:
- Add `network String @default("solana-devnet") @db.VarChar(24)` to each.
- Change single-column `@id` to composite `@@id([network, X])` on Call (X=callId), Settlement (X=signature), PoolState (X=endpointSlug), RecipientEarnings (X=recipientPubkey), Endpoint (X=slug).
- Update `@@index` lists to be `network`-prefixed on query-path indexes.
- Update `@relation` directives where the FK is now composite (Call→Endpoint, PoolState→Endpoint, SettlementRecipientShare→Settlement).

- [ ] **Step 3: Generate the migration**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
cd packages/db
pnpm dlx prisma migrate dev --name add_network_column --create-only 2>&1 | tail -15
```

(`--create-only` generates SQL without applying — review before apply.)

Read the generated `migration.sql`. Confirm it:
1. Adds the `network` column with default to each table BEFORE altering primary keys (Postgres requires the column to exist before composite PK references it).
2. Drops old single-column primary keys and creates new composite primary keys in the right order.
3. Updates foreign key constraints to composite.
4. Does NOT have any data-loss operations (no `DROP TABLE`, no `DROP COLUMN` of existing fields).

If the generated SQL has a problem, PAUSE and surface as BLOCKED — Prisma may need an explicit manual sequence.

- [ ] **Step 4: Apply locally + test forward path**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
cd packages/db
# Apply against local dev DB (must be running):
pnpm dlx prisma migrate dev 2>&1 | tail -10
```

Expected: migration applies cleanly.

- [ ] **Step 5: Write the rollback CI test**

Create `packages/indexer/test/migration-rollback.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { PrismaClient } from "@pact-network/db";

// CI test exercising the WP-MN-03a Prisma migration forward + backward.
// Requires DATABASE_URL pointing to a test Postgres (CI provides this).
// Locally, run with a docker-compose postgres if DATABASE_URL is unset.

describe("WP-MN-03a migration — forward/backward integrity", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    // Reset to pre-WP state — apply all migrations EXCEPT the new one.
    // (Implementation: spin up a clean DB, apply baseline migrations, then
    // seed sample rows BEFORE the new migration.)
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("forward migration adds network='solana-devnet' to all existing rows", async () => {
    // Seed: insert one row in each of Call, Settlement, SettlementRecipientShare,
    // PoolState, RecipientEarnings, Endpoint BEFORE the migration is applied.
    // Then apply migration. Then read back; expect every row has network='solana-devnet'.
  });

  it("composite primary key prevents same-callId duplicate within solana-devnet", async () => {
    // Try inserting two Calls with the same (network, callId) — second must fail
    // with P2002 (Prisma unique-constraint violation).
  });

  it("composite primary key allows same callId across different networks", async () => {
    // Insert Call (network='solana-devnet', callId='X') + Call (network='arc-testnet', callId='X').
    // Both should succeed.
  });

  it("foreign keys updated to composite — Call->Endpoint references (network, slug)", async () => {
    // Insert Endpoint (network='solana-devnet', slug='helius').
    // Try inserting Call with endpointSlug='helius' but on a DIFFERENT network — must fail FK.
  });
});
```

(Full implementation needs the CI Postgres harness — match the existing indexer test infrastructure pattern in `packages/indexer/test/`.)

- [ ] **Step 6: Run the rollback test**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/indexer test migration-rollback 2>&1 | tail -15
```

Expected: 4 tests pass.

- [ ] **Step 7: Verify full indexer test suite still green**

Indexer's existing tests may reference rows without `network` — Prisma client throws if a required field is missing. Since `network` has a `@default("solana-devnet")`, this should auto-populate, but test fixtures inserting via raw SQL or via `prisma.create({ data: { ... } })` without specifying network may need updating.

```bash
pnpm --filter @pact-network/indexer test 2>&1 | tail -20
```

Fix any test fixture that needs updating.

- [ ] **Step 8: Commit**

```bash
git add packages/db/prisma/ packages/indexer/test/migration-rollback.test.ts
git commit -m "feat(db): +network column on 6 tables with composite PKs (WP-MN-03a T3)

Adds 'network String @default(\"solana-devnet\") @db.VarChar(24)' to:
Call, Settlement, SettlementRecipientShare, PoolState,
RecipientEarnings, Endpoint.

Composite primary keys (network, X) replace single-column @id on
all 6. Foreign-key directives updated to composite.

Backfill: Postgres applies the column default to all existing rows
in the same DDL transaction. No down-migration data loss.

CI gate: packages/indexer/test/migration-rollback.test.ts exercises
forward+backward + composite-PK uniqueness + composite-FK constraint.

Highest-risk WP-MN-03a sub-task. Cloud SQL snapshot pre-apply
documented in mn-03a Gate B runbook (not in code)."
```

---

## Task 4: Indexer ingest composite-key + default-network for legacy events

**Goal:** Update `events.service.ts` upserts to use composite `(network, ...)` keys. The `@Post('/events')` handler defaults `network='solana-devnet'` when absent. No false-positive duplicates during the deploy ramp.

**Files:**
- Modify: `packages/indexer/src/events/events.service.ts`
- Modify: `packages/indexer/src/events/events.controller.ts`
- Modify: `packages/indexer/src/events/events.service.spec.ts` (update fixtures + add network-default tests)

- [ ] **Step 1: Add network-default in controller**

Edit `packages/indexer/src/events/events.controller.ts`:

```typescript
@Post()
async ingest(@Body() dto: SettlementEventDto) {
  // WP-MN-03a: default to solana-devnet for legacy unstamped events.
  const network = dto.network ?? dto.calls[0]?.network ?? "solana-devnet";
  return this.eventsService.ingest({
    ...dto,
    network,
    calls: dto.calls.map((c) => ({ ...c, network: c.network ?? network })),
  });
}
```

- [ ] **Step 2: Update events.service composite-key upserts**

Edit `packages/indexer/src/events/events.service.ts`. Around line 168 — Settlement upsert:

```typescript
await tx.settlement.upsert({
  where: { network_signature: { network: dto.network, signature: dto.signature } },
  create: {
    network: dto.network,
    signature: dto.signature,
    batchSize: dto.batchSize,
    totalPremiumsLamports: BigInt(dto.totalPremiumsLamports),
    totalRefundsLamports: BigInt(dto.totalRefundsLamports),
    ts: new Date(dto.ts),
  },
  update: {},
});
```

(Prisma's composite-key where clause uses the field name `network_signature` derived from `@@id([network, signature])`.)

Also update `tryInsertCall` (around line 130–150) — Call insertion. Composite where: `network_callId: { network, callId }`. Use `network` from `call.network ?? dto.network ?? "solana-devnet"`.

Apply the same pattern to PoolState, RecipientEarnings, SettlementRecipientShare upserts.

- [ ] **Step 3: Update existing tests + add new ones**

Existing events.service.spec.ts tests insert rows; update fixtures to include `network: 'solana-devnet'` where needed (Prisma will auto-default but explicit is clearer).

Add new tests:
- Legacy unstamped event (no network on DTO) gets defaulted to solana-devnet.
- Two events with the same callId across different networks both succeed.
- A duplicate (network, callId) within the same network is silently ignored (P2002 swallow).

- [ ] **Step 4: Verify**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/indexer test 2>&1 | tail -15
```

Expected: all green. Fix any test fixture breaks.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/
git commit -m "feat(indexer): composite-key idempotency + legacy-event default (WP-MN-03a T4)

events.controller.ts: default network='solana-devnet' for legacy
unstamped events (per off-chain §2.6 REV1).
events.service.ts: all upserts (Settlement, Call, PoolState,
RecipientEarnings, SettlementRecipientShare) use composite
(network, X) where-clauses. P2002 duplicate-swallow preserves
existing silent-skip behavior.

Test count: +3 (legacy-default, cross-network same-callId,
within-network duplicate ignore)."
```

---

## Task 5: Read-API `?network=` filter + wire-compat e2e

**Goal:** All 5 read-API endpoint surfaces accept optional `?network=`. Default = aggregate across networks. Plus an e2e test exercising pre↔post 03a wire combinations.

**Files:**
- Modify: `packages/indexer/src/stats/stats.controller.ts`
- Modify: `packages/indexer/src/api/calls.controller.ts`
- Modify: `packages/indexer/src/api/endpoints.controller.ts`
- Modify: `packages/indexer/src/api/agents.controller.ts`
- Create: `packages/indexer/test/wire-compat.e2e.test.ts`

- [ ] **Step 1: Add `?network=` to each controller**

For each controller, in each @Get handler:

```typescript
@Get()
async list(@Query("network") network?: string) {
  if (network !== undefined && !isKnownNetwork(network)) {
    throw new BadRequestException(
      `Unknown network "${network}". Known: ${listChains().map((c) => c.network).join(", ")}`,
    );
  }
  return this.service.list({ network }); // service-side: undefined = aggregate
}
```

Add a helper:

```typescript
import { listChains } from "@pact-network/shared";

function isKnownNetwork(network: string): boolean {
  return listChains().some((c) => c.network === network);
}
```

Update the corresponding service method to accept `{ network }` and pass it into the Prisma `where` clause. When `network` is undefined, no filter is applied (default aggregate).

- [ ] **Step 2: Add `@pact-network/shared` dep to indexer**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
# Edit packages/indexer/package.json — add "@pact-network/shared": "workspace:*" to dependencies.
pnpm install 2>&1 | tail -5
```

- [ ] **Step 3: Write the wire-compat e2e test**

Create `packages/indexer/test/wire-compat.e2e.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import type { INestApplication } from "@nestjs/common";

describe("WP-MN-03a — wire compat (pre↔post 03a)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it("accepts a legacy unstamped SettlementEvent (no network field) and defaults to solana-devnet", async () => {
    const legacyDto = {
      signature: "fake-sig-1",
      batchSize: 1,
      totalPremiumsLamports: "100",
      totalRefundsLamports: "0",
      ts: new Date().toISOString(),
      calls: [{ /* WrapCallEventDto without network field */ }],
      // no network at the top level either
    };
    // POST /events with legacyDto
    // expect 200
    // query DB: SELECT * FROM Call WHERE callId = ... — expect network='solana-devnet'
  });

  it("accepts a network-stamped SettlementEvent and routes correctly", async () => {
    // Same but with network: 'solana-devnet' explicitly stamped.
  });

  it("read API /api/calls?network=solana-devnet narrows to that network", async () => {
    // GET /api/calls?network=solana-devnet — expect filtered results.
  });

  it("read API /api/calls without ?network= returns aggregate across networks", async () => {
    // GET /api/calls — expect all networks.
  });
});
```

- [ ] **Step 4: Verify**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/indexer test 2>&1 | tail -15
pnpm -r typecheck 2>&1 | tail -10
```

Expected: all green; cross-package typecheck OK.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/
git commit -m "feat(indexer): ?network= filter on 5 read-API surfaces + wire-compat e2e (WP-MN-03a T5)

5 endpoint surfaces accept optional ?network=:
- GET /api/stats
- GET /api/endpoints, GET /api/endpoints/:slug
- GET /api/agents/:pubkey, GET /api/agents/:pubkey/calls
- GET /api/calls, GET /api/calls/:id

Default = aggregate across networks (existing behavior preserved).
Explicit value narrows; unknown network throws 400.

Wire-compat e2e (4 tests): legacy unstamped event → default
solana-devnet; stamped event routes correctly; filter narrows;
no-filter aggregates.

Final WP-MN-03a implementation task complete."
```

---

## After all tasks

Gate B request: `mn-03a-REPORT-gateB.md` covers the 7-cat template (PLANs closed, tests green with counts, drift/contract checks, spec-parity, rollback tag, captain verdict pending, handoff updated).

Captain-proxy Gate B verdict → tag `pre-mn-03b-rollback` on `feat/multi-network` post-merge.

Open PR vs `feat/multi-network`, merge with merge-commit.

Update cockpit handoff. Proceed to WP-MN-03b (the actual chain-touch swap; the riskiest WP).
