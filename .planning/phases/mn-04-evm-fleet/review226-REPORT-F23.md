# Review #226 — FIX F2 + F3 (indexer accounting consistency) — REPORT

**Status:** DONE (both BLOCKING findings resolved)
**Branch:** `feat/concurrent-multi-evm`
**Commit:** `5b3567b` — `fix(indexer): resolve one batch network + scope recipient-share idempotency by network (review #226 F2,F3)`
**Scope:** both fixes in `packages/indexer/src/events/events.service.ts` + tests in `packages/indexer/test/events.service.spec.ts`. No other files touched.

---

## Rick's findings (verbatim)

### F2 — `events.service.ts:130` and `:351`

The indexer allows `dto.network` and per-call `call.network` to diverge.
Aggregates use `batchNetwork = dto.network ?? "solana-devnet"`, while
`tryInsertCall()` writes each `Call` under `call.network ?? "solana-devnet"`. A
malformed or replayed indexer POST can split accounting: `Call` under
`arc-testnet`, but `Settlement`, `Endpoint`, `PoolState`,
`SettlementRecipientShare`, and `RecipientEarnings` under `solana-devnet`, or
vice versa.

Fix: resolve one batch network as `dto.network ?? calls[0]?.network ??
"solana-devnet"` and reject the payload if any call resolves to a different
network. Then use that resolved network consistently for every row in the
transaction.

Required tests: mixed `dto.network` / `call.network` must return 400 and create
no rows; unstamped legacy batches should still resolve wholly to `solana-devnet`.

### F3 — `events.service.ts:270-272`

`SettlementRecipientShare` idempotency checks only `settlementSig`, ignoring
`network`, even though `Settlement` and recipient-share rows are now
network-scoped. If the same tx/hash string appears on another network, the
second network's share rows and recipient earnings are skipped while calls,
settlement, and pool state can still update.

Fix: scope the check to `{ network: batchNetwork, settlementSig: dto.signature }`.
If duplicate recipient rows per batch are not intended, also consider a composite
uniqueness constraint over `(network, settlementSig, recipientKind, recipientPubkey)`.

Required tests: ingest two batches with the same `signature` on different
networks and assert both networks create their own settlement shares and
recipient earnings.

---

## Fix F2 — one resolved network for the whole batch

1. **Resolve + divergence-check BEFORE the transaction** (so a rejection
   creates zero rows). After the existing per-call `shares` validation:

   ```ts
   const batchNetwork = dto.network ?? dto.calls[0]?.network ?? "solana-devnet";
   for (const call of dto.calls) {
     const callNetwork = call.network ?? batchNetwork;
     if (callNetwork !== batchNetwork) {
       throw new BadRequestException(/* ...review #226 F2... */);
     }
   }
   ```
   A call with no explicit `network` **inherits** `batchNetwork` (never
   diverges). A call whose explicit `network` disagrees with the resolved batch
   network is the malformed/replayed case → `BadRequestException` (NestJS maps
   to HTTP 400, same path as the pre-existing `shares`-missing 400).

2. **Removed the in-transaction redeclaration** `const batchNetwork = dto.network ?? "solana-devnet";`
   (old line 130). `batchNetwork` is now the single method-scope value the
   transaction closure reads for every aggregate row (Settlement, Endpoint,
   PoolState, SettlementRecipientShare, RecipientEarnings).

3. **Threaded the resolved network into `tryInsertCall`.** Added a `network:
   string` parameter; the Call row now writes `network` (the batch-resolved
   value) instead of `call.network ?? "solana-devnet"`. This closes the
   "vice versa" split where `dto.network` was set but `call.network` was unset —
   previously the Call row landed under `solana-devnet` while aggregates landed
   under `dto.network`. Sole caller (line 163) updated in the same edit.

This makes the divergence the finding describes structurally impossible: every
row in the transaction uses one value, and any payload that would have split is
rejected at the door.

## Fix F3 — network-scoped recipient-share idempotency

Scoped the existence check by network:

```ts
const existingShares = await tx.settlementRecipientShare.count({
  where: { network: batchNetwork, settlementSig: dto.signature },
});
```

The required fix (network scoping) is applied. The optional "also consider"
composite uniqueness constraint over `(network, settlementSig, recipientKind,
recipientPubkey)` was **not** added — it is a schema migration outside this
finding's required fix and carries its own rollout/rollback risk; flagged here
for a follow-up if duplicate-per-batch rows ever need a hard DB guard. The
existing `@@index([network, settlementSig])` on the model already backs this
filter efficiently.

## Tests (TDD — RED written first, watched fail, then GREEN)

Mirrors the existing real-seam style: real `EventsService` + a fake Postgres
(`makePrismaMock`) recording every row's network. The seam (the service) is
never mocked.

**Test-infra change required for F3 to be observable:** the fake
`settlementRecipientShare.count` previously always returned `0`, so the F3 bug
could not manifest. It now stores `createMany` rows and honors the `where`
filter (a row matches when every field in `where` equals the row's value). With
the buggy sig-only filter, a second-network batch matches the first network's
rows; with the fixed `(network, sig)` filter it does not. `$transaction`
rollback also snapshots/restores this store. This is test fidelity, not seam
mocking.

| Test | RED (before fix) | GREEN (after fix) |
|---|---|---|
| F2: divergent `call.network` vs `dto.network` → 400, zero rows | ingest resolved `{accepted:1}` instead of throwing | `BadRequestException`, `captured.length === 0` |
| F2: omitted `call.network` inherits resolved network for every row | Call row landed `solana-devnet`, aggregates `arc-testnet` | all rows `arc-testnet` |
| F3: same signature on two networks creates shares + earnings for both | only `solana-devnet` shares/earnings (arc skipped) | both `arc-testnet` + `solana-devnet` |

Pre-existing `regression: an unstamped batch lands every row under solana-devnet`
covers the F2 legacy fallback requirement and stays green.

## Before / after suite

| Suite | Before | After |
|---|---|---|
| `events.service.spec.ts` | 16 passed | **19 passed** (+3 F2/F3 tests) |
| Full indexer suite | 93 passed, 4 env-only failed | **96 passed**, 4 env-only failed |
| `indexer` build (`nest build`) | clean | clean |

The 4 failures are the pre-existing **env-only** `migration-rollback.spec.ts`
suite — "Authentication failed against database server at `localhost`" (needs a
live Postgres). Documented as ×4 env-only in the #226 PR description; unrelated
to this change (which is fully covered by `events.service.spec`, 19/19).

## Compliance with hard rules

- TDD RED-first: all 3 new tests watched fail for the correct reason before any
  production edit (divergence not rejected; Call row under wrong network; arc
  shares skipped).
- Surgical: 2 files, +190/−11. Every changed line traces to F2 or F3. No
  drive-by refactors.
- Zero regression: full indexer 96/96 (excluding the 4 pre-existing env-only
  DB-auth failures), build clean.
- pnpm only; no emojis.
- Manual impact analysis (gitnexus `analyze` skipped per the CLAUDE.md worktree
  gotcha — it would rewrite CLAUDE.md/AGENTS.md to the worktree dir name):
  `tryInsertCall` is private with one caller (line 163, updated in-edit);
  `ingest` is called only by `events.controller.ts:23` and its signature is
  unchanged (only an added 400 throw path the controller already propagates).
  Commit verified to contain exactly the 2 intended files; no CLAUDE.md /
  AGENTS.md corruption.

## Files changed (2)

```
packages/indexer/src/events/events.service.ts | 44 ++++++--
packages/indexer/test/events.service.spec.ts  | 157 ++++++++++++++++++--
```
