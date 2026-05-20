# WP-MN-03a — +network wire + DB column — CONTEXT

- **Track:** Multi-Network refactor (MN), third WP (P3 split first half)
- **Branch:** `feat/multi-network-03a-network-wire` (off `feat/multi-network@d358e86` after WP-MN-02 merge)
- **Captain:** Tu (out-of-office); captain-proxy continues per directive
- **Date opened:** 2026-05-20

## Purpose

Make the off-chain pipeline multi-network-aware **on the wire and in storage** without swapping any chain-touch code yet. Pure additive change:
- `SettlementEvent` (and its indexer-DTO superset `WrapCallEventDto`) gain `network?: string`.
- Prisma schema gains a `network` column on the six affected tables; existing rows backfill to `'solana-devnet'`.
- `market-proxy` and `settler` stamp `network` on every event they produce; `indexer` accepts `+network` with backward-compat default `'solana-devnet'` for unstamped legacy events.
- Indexer's idempotency key migrates from `signature` to the composite `(network, callId)` per off-chain §2.6 REV1.
- Read API endpoints accept `?network=` (default = aggregate across networks).

**Nothing about the chain-touch code changes here.** Services still call `protocol-v1-client` + `wrap` directly; the SolanaAdapter (WP-MN-02) is sitting in `@pact-network/shared` unconsumed. WP-MN-03b swaps services to consume it.

## Upstream artifacts (READ FIRST)

- `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §5 — WP-MN-03a deliverables, Gate A entry, 7-cat Gate B exit. Highest plan-level risk: live indexer Prisma migration (PR-R1).
- `docs/evm/2026-05-19-multi-network-offchain-services-spec.md`:
  - §2.2 — the `+network` wire change is ONLY ADDITIVE (NO `premiumLamports` rename, NO `outcome` collapse to `breach: boolean`).
  - §2.4 — registry consumed by services.
  - §2.6 — per-VM auth + reorg + idempotency key migration from `signature` to `(network, callId)`.
- `.planning/phases/mn-02-chain-adapter/mn-02-REPORT-gateB.md` §"Carry forward to WP-MN-03b RESEARCH" — note that the EndpointConfigSnapshot projection drift is for WP-MN-03b RESEARCH, not this WP.

## In scope

- **Wire (`packages/wrap/src/types.ts`):** add `network?: string` to `SettlementEvent`. Optional during the migration; downstream defaults to `'solana-devnet'`.
- **Indexer DTO (`packages/indexer/src/events/events.dto.ts`):** add `network?: string` to `WrapCallEventDto` and `SettlementEventDto`. Accept legacy unstamped events (default `'solana-devnet'`).
- **Producer stamping:**
  - `market-proxy` — stamp `'solana-devnet'` on every event it produces. Read via `getChain()` registry (WP-MN-02), not a hardcoded constant.
  - `settler` — propagate the network from incoming events to settler-emitted DTOs.
- **Prisma schema** (`packages/db/prisma/schema.prisma`): add `network String @default("solana-devnet") @db.VarChar(24)` column to: `Call`, `Settlement`, `SettlementRecipientShare`, `PoolState`, `RecipientEarnings`, `Endpoint`. Indexes updated to include `network` where appropriate.
- **Migration:** forward + down migrations in `packages/db/prisma/migrations/`. Down-migration tested in CI. Backfill SQL stamps existing rows with `'solana-devnet'`.
- **Indexer idempotency key:** the duplicate-detection logic in the `POST /events` ingest path migrates from "is `signature` already in DB?" to "is `(network, callId)` already in DB?". The composite-key Prisma constraint added alongside the column migration.
- **Read API `?network=` filter:** `/api/stats`, `/api/endpoints`, `/api/agents/:pubkey`, `/api/agents/:pubkey/calls`, `/api/calls/:id` all accept optional `?network=` query param; default = aggregate across networks.

## Out of scope

- **No chain-touch swap.** Services keep calling `protocol-v1-client` + `wrap` directly. WP-MN-03b's `PACT_USE_DIRECT_CLIENT` env flag is NOT introduced here.
- **No EvmAdapter.** Settler's "EVM branch" routing exists but returns "unsupported" stub until WP-MN-04.
- **No `outcome → breach` reshape.** Off-chain §2.2 REV1 explicitly: `outcome` stays the discriminated union; the indexer's existing `outcomeToBreach()` projector keeps doing its job.
- **No `premiumLamports → premiumBaseUnits` rename.** Off-chain §2.2 REV1: only `+network` changes.
- **No Solana mainnet "network" value.** Stay on `'solana-devnet'` for the backfill; mainnet flip is a separate concern.
- **No legacy Anchor crate edits.**

## Non-negotiables

1. **Wire backward compat.** A pre-WP-MN-03a settler against a post-WP-MN-03a indexer must work (legacy unstamped events default `network='solana-devnet'`). And vice versa: a post-03a settler producing `network`-stamped events against a pre-03a indexer must not crash (the field is optional).
2. **Down-migration tested in CI.** Forward migration applies cleanly to a seeded DB; down migration rolls back to the pre-WP state without data loss.
3. **No row left behind.** Every existing row in Call, Settlement, SettlementRecipientShare, PoolState, RecipientEarnings, Endpoint gets stamped with `network='solana-devnet'` during backfill.
4. **Indexer accepts BOTH idempotency-key shapes during the transition window.** The composite `(network, callId)` unique constraint is added; the old `signature` unique constraint (where applicable) is relaxed only after backfill verifies no duplicates.
5. **No remote pushes during captain-proxy execution.**

## Gate-A entry criteria

Satisfied by this CONTEXT + the companion `mn-03a-RESEARCH.md`:
- Off-chain spec §2.2 + §2.4 + §2.6 read.
- RESEARCH enumerates every producer of `SettlementEvent` AND every consumer of `signature` as an idempotency key in the indexer.
- Idempotency-key migration strategy decided in RESEARCH (composite `(network, callId)` on existing rows; verify no orphans).
- Prisma schema diff drafted.
- Captain VERDICT APPROVED — pending.

## Captain expectations of Gate-A verdict

Captain (or proxy) reads `mn-03a-RESEARCH.md` and confirms:
- The producer enumeration is exhaustive (no `SettlementEvent` constructor outside the listed sites).
- The Prisma migration strategy is reversible and CI-tested before merge.
- The idempotency-key migration handles the transition window correctly (no false-positive duplicate rejections during deploy ramp).
- The read-API `?network=` filter semantics are clear (default aggregate; explicit filter narrows).
- No service file gets a chain-touch swap (out of scope; that's WP-MN-03b).
