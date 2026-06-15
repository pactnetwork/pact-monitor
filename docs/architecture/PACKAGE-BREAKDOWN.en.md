# Pact Network — Per-package Breakdown (EN)

> Written 2026-06-03 on branch `feat/multi-network @ 2b5cb0c`, after the off-chain V2 stack was removed.
> Each package answers 5 questions: **(1) What it is · (2) What it means for the project · (3) What breaks
> without it · (4) Does it overlap anything · (5) What it depends on.** Dependency relationships are taken
> directly from `package.json` (`dependencies` + `devDependencies`).

## Current state (2026-06-03 — consistent across all three docs)

This breakdown, `ARCHITECTURE.{en,vi}.md`, and `DIVERGENCE-AUDIT.{en,vi}.md` were ALL updated on **2026-06-03**
to reflect commit `2b5cb0c` (off-chain V2 removal). They agree on the following:

- **5 off-chain V2 packages were fully removed:** `wrap-v2`, `settler-v2`, `indexer-v2`, `db-v2`,
  `protocol-v2-client`. Their directories were deleted entirely in commit `2b5cb0c` (no leftover `dist/` or
  `node_modules`) ⇒ **no action needed** — the cleanup is already done.
- The number of "live" packages is now **~17 TS + 2 on-chain** (not 24 as the old docs stated); the V2 dirs are
  gone.
- **Debt D2 ("2 parallel V2 Solana clients") is half-resolved:** `protocol-v2-client` is gone, only
  `insurance` remains. No longer "parallel" — just one V2 client.
- **Debt D1 ("classifier in 5 copies") was overstated:** see `ANALYSIS.md` for the real picture — `wrap-v2`
  is deleted, `market-proxy` already *imports* `wrap` (not a copy), and the only true copy lives at
  `backend/src/routes/monitor.ts:24`.

---

## GROUP A — Rails core (shared core, reusable)

### `wrap` — `@pact-network/wrap`
- **What it is:** A library that "wraps" a `fetch()` call to turn it into an *insured* call: it checks the
  agent's balance, attaches `X-Pact-*` headers, computes the premium, and **classifies the result
  (classifier)** → ok / latency_breach / server_error / client_error / network_error, along with the premium
  and refund amounts.
- **What it means:** This is the **heart of the off-chain business logic**. Every interface (Market proxy,
  x402 facilitator) runs through it. The `classifier.ts` here is the **canonical source of truth** for SLA rules.
- **What breaks without it:** The entire insurance layer collapses — the proxy/facilitator no longer know when
  to charge or refund. Not replaceable; would have to be rewritten from scratch.
- **Overlap:** The classifier logic is *duplicated* (not imported) in `monitor` and
  `backend/routes/monitor.ts`; the premium/refund logic is duplicated in `facilitator/lib/coverage.ts`
  (`computeCoverage`). → the main target of P1.
- **Depends on:** Nothing (leaf). This is a good thing — keep it dependency-light.

### `shared` — `@pact-network/shared`
- **What it is:** The multi-VM abstraction layer (ports-and-adapters): defines `ChainAdapter` + `SolanaAdapter`
  + `EvmAdapter`, plus the PDA seed constants and shared types.
- **What it means:** **It is the "seam" that lets the same code run on both Solana and EVM (Arc, Base).** Adding
  a new chain = writing one more adapter; settler/indexer/proxy don't change. This is the architectural
  highlight of this branch.
- **What breaks without it:** Multi-network support is lost — settler/indexer/proxy would have to hardcode each
  chain, the code bloats and branches everywhere.
- **Overlap:** None. A unique role.
- **Depends on:** `protocol-v1-client`, `protocol-evm-v1-client`, `wrap`.

### `protocol-v1-client` — `@q3labs/pact-protocol-v1-client`
- **What it is:** TS client for the Solana v1 program (Pinocchio): PDA helpers, instruction builders, account
  decoders, error map.
- **What it means:** The sole bridge between TS code and the on-chain Solana v1 program. Published (scope
  `@q3labs`).
- **What breaks without it:** Nothing can call/read the Solana program — the settler can't settle, the indexer
  can't decode, the dashboard/SDK/CLI lose their entry into the chain.
- **Overlap:** None (it's for v1; `insurance`/`protocol-v2-client` are for v2).
- **Depends on:** Nothing (leaf).

### `protocol-evm-v1-client` — `@pact-network/protocol-evm-v1-client`
- **What it is:** TS client for the 3-contract Solidity EVM v1 set (`PactPool`, `PactSettler`, `PactRegistry`):
  ABI, addresses, encode, state reads, errors.
- **What it means:** The EVM counterpart of `protocol-v1-client`; it is what makes multi-network (Arc/Base) real
  at the server layer.
- **What breaks without it:** The entire EVM branch of the server fleet is lost — only Solana remains.
- **Overlap:** None. (The SDK/CLI have their *own* EVM path via `viem` — that is intentional layering, not
  duplication.)
- **Depends on:** Nothing (leaf).

---

## GROUP B — Server services (backbone, good reuse)

### `settler` — `@pact-network/settler`
- **What it is:** A NestJS service that consumes the Pub/Sub queue and submits `settle_batch` transactions
  on-chain (gathering premium into pool/treasury/integrator, refunding on breach).
- **What it means:** It is the "hand" that writes money on-chain. Without it, settlement events just sit in the
  queue and never reach the chain.
- **What breaks without it:** Premium/refund is never settled → the product loses its meaning.
- **Overlap:** None (settler-v2 deleted). Previously parallel to settler-v2, now the only one.
- **Depends on:** `shared`, `wrap`, `protocol-v1-client`, `protocol-evm-v1-client`. (Reuses the backbone
  correctly.)

### `indexer` — `@pact-network/indexer`
- **What it is:** A NestJS service that receives settlement events (`POST /events`), writes to Postgres, serves
  the read API, delivers refunds, and handles reorgs.
- **What it means:** It is the system's "memory" + read API — the data source for the dashboard and
  reconciliation.
- **What breaks without it:** No history/stats/refund-delivery; the dashboard is blank; nothing is auditable.
- **Overlap:** None (indexer-v2 deleted).
- **Depends on:** `shared`, `db`, `protocol-v1-client`, `protocol-evm-v1-client`.

### `db` — `@pact-network/db`
- **What it is:** The Prisma schema for the indexer (PoolState, Settlement, SettlementRecipientShare,
  RecipientEarnings).
- **What it means:** The data contract for the persistence layer; only `indexer` uses it.
- **What breaks without it:** The indexer has no schema to write/read.
- **Overlap:** `db-v2` used to exist (deleted) and shared a Prisma output, causing a build race — now only `db`
  remains.
- **Depends on:** Nothing (leaf).

---

## GROUP C — Pact Market (one interface on top of the rails)

### `market-proxy` — `@pact-network/market-proxy`
- **What it is:** A Hono proxy (Cloud Run) wrapping curated providers (Helius, Birdeye, Jupiter, Elfa, fal.ai);
  consumes `wrap` to insure each call.
- **What it means:** It is the "Pact Market" product — the commercial surface of the rails. `lib/classifiers.ts`
  is the **reference example** of how to *import* `wrap`'s classifier (the Helius plugin) — exactly the pattern
  P1 wants to spread.
- **What breaks without it:** The Market product is lost (but the rails stay alive — others can still build on
  the rails).
- **Overlap:** **None** — it imports `wrap`, doesn't copy it. (The old docs mis-classified it as "one of the 5
  copies".)
- **Depends on:** `shared`, `wrap`, `protocol-evm-v1-client`. Depends *indirectly at runtime* on keys issued by
  `backend`.

### `market-dashboard` — `@pact-network/market-dashboard`
- **What it is:** A Next.js 15 dashboard (App Router, Tailwind 4, wallet-adapter) for Pact Market.
- **What it means:** The UI surface for Market users to view pools/agents/settlements.
- **What breaks without it:** The Market UI is lost; data is still reachable via the indexer API.
- **Overlap:** Conceptually overlaps `scorecard` (both are frontends) but it's a different product/generation
  (Market vs legacy scorecard).
- **Depends on:** `protocol-v1-client` (reads on-chain state client-side).

---

## GROUP D — SDK / CLI / x402 (client interfaces)

### `sdk` — `@q3labs/pact-sdk`
- **What it is:** Agent-side SDK (createPact, golden-fetch, Solana + EVM signing via `viem`).
- **What it means:** The "standard" way for devs to integrate an agent into Pact without going through the
  Market proxy. **This is the central package of Rick's decision #1** (one SDK + merchant subpath vs two
  packages).
- **What breaks without it:** Devs have to build insured calls themselves — a large integration barrier.
- **Overlap:** Partially conceptual with `monitor` (both wrap fetch client-side) and with the merchant surface
  in PR #223 (not merged). Needs Rick to lock the shape to avoid drift.
- **Depends on:** `protocol-v1-client` (+ `viem` for EVM). Does **not** use `shared` — correct layering for a
  client.

### `cli` — `@q3labs/pact-cli` (binary `pact`)
- **What it is:** A multi-network CLI (Solana + Arc + Base): `pay` (wraps x402/MPP), operator operations.
  Bundled with `bun build` into a single `dist/pact.js` file.
- **What it means:** The command-line surface for operators/agents. **The subject of Rick's decision #2** (one
  `pact` or a separate x402 binary).
- **What breaks without it:** No command-line operations; you'd have to use the SDK/scripts manually.
- **Overlap:** `lib/pay-classifier.ts` (an stdout/stderr parser) is a *different classifier domain* — not a copy
  of `wrap`. `lib/facilitator.ts` + `lib/envelope.ts` re-implement the *contract* of the `facilitator` package
  (a minor debt D4).
- **Depends on:** `protocol-v1-client`, `monitor` (declared under `devDependencies` because it is bundled —
  correct, not a bug).

### `facilitator` — `@pact-network/facilitator`
- **What it is:** An x402-style facilitator: receives a "verdict" from the CLI/agent, maps it to `wrap`'s
  canonical `Outcome`, computes premium/refund, generates a deterministic coverageId to prevent duplicates.
- **What it means:** The x402 interface on top of the rails — lets the `pay.sh`/x402 flow plug into the
  settlement system.
- **What breaks without it:** The x402 path is lost; agents using x402/MPP can't be insured.
- **Overlap:** `coverage.ts` `computeCoverage` **duplicates `wrap`'s premium/refund logic** (the doc itself
  says "identical to wrap's defaultClassifier"). → a P2.5 candidate the old audit missed.
- **Depends on:** `wrap`.

---

## GROUP E — Pre-Step-A / legacy (still running, needs fencing)

### `monitor` — `@q3labs/pact-monitor`
- **What it is:** A standalone SDK that wraps `fetch()` to *measure reliability*
  (success/timeout/schema_mismatch/server/client_error) + schema validation. Has its own classifier.
- **What it means:** Serves the public scorecard / the first-generation SDK demo. Imported by the CLI.
- **What breaks without it:** The reliability classification source for the scorecard is lost; the CLI loses one
  dependency.
- **Overlap:** Its classifier **overlaps conceptually** with `wrap` but with a different vocabulary/input (raw
  statusCode, no economics). This `classify` is also **copied verbatim** into `backend/routes/monitor.ts:24` →
  *that* is the real copy to remove.
- **Depends on:** Nothing (leaf). 0 internal deps — a standalone island (debt D3, largely intentional).

### `insurance` — `@q3labs/pact-insurance`
- **What it is:** TS SDK for the V2 (legacy) insurance program: `client.ts` + `kit-client.ts` +
  `legacy-anchor-client.ts` + `generated/`.
- **What it means:** The *sole remaining* V2 client after `protocol-v2-client` was deleted. `backend` (the
  claims/V2 part) depends on it.
- **What breaks without it:** The V2/claims part of `backend` breaks; but the Market control-plane (the
  release-critical part) is **not** affected.
- **Overlap:** Previously parallel to `protocol-v2-client` (debt D2) — **no longer parallel** (the other one was
  deleted). `legacy-anchor-client.ts` is kept only as a rollback path.
- **Depends on:** Nothing (leaf).

### `backend` — `@pact-network/backend`
- **What it is:** The live Market control-plane (Fastify): private-beta gate, self-serve API-key issuance,
  faucet, partners/CRM. **Plus** the old scorecard routes (providers/records/analytics) + the V2 claims part.
- **What it means:** **NOT dead legacy** — `market-proxy` validates keys it issues ⇒ release-critical. The
  legacy part is only the scorecard + V2 claims, already fenced off neatly (`routes/pools.ts` + `crank/*` +
  `services/claim-settlement.ts`).
- **What breaks without it:** Keys can't be issued/revoked → the Market proxy lets no one in;
  faucet/onboarding break.
- **Overlap:** `routes/monitor.ts:24` contains the **copy of `monitor`'s classifier** (safe to remove). The
  V2/claims part uses `insurance` (separable later).
- **Depends on:** `insurance` (only for the V2/claims branch, not the control-plane).

### `scorecard` — `@pact-network/scorecard`
- **What it is:** The Vite+React frontend of the first-generation public scorecard; calls `backend` over HTTP.
- **What it means:** The provider-reliability ranking surface (legacy). Decoupled, calls REST.
- **What breaks without it:** The public scorecard page is lost; no impact on the rails/Market.
- **Overlap:** Overlaps the "frontend" role with `market-dashboard` but it's a different product/generation. A
  legacy carve-out candidate.
- **Depends on:** Nothing (leaf; only calls backend over HTTP, not through the workspace).

### `dummy-upstream` — `@pact-network/dummy-upstream`
- **What it is:** A keyless fake upstream for smoke tests.
- **What it means:** A test tool; lets the proxy flow run end-to-end without burning real provider quota.
- **What breaks without it:** Smoke tests have to call real providers (costs keys/money, flaky).
- **Overlap:** None.
- **Depends on:** Nothing (leaf).

---

## GROUP F — On-chain (not via package.json)

### `program` (Rust)
- **What it is:** Holds the Solana Pinocchio **v1** program (`pact-network-v1-pinocchio`, running), the
  Pinocchio **v2** program (future), and the Anchor crate `pact-insurance` **LEGACY** (rollback only, do not
  modify).
- **What it means:** It is the on-chain Solana law — where money is actually gathered/split/refunded.
- **What breaks without it:** No Solana settlement.
- **Overlap:** The legacy Anchor crate overlaps the role of Pinocchio v1 but is frozen (fallback only).
- **Depends on:** `protocol-v1-client` maps to it (reverse direction: client → deployed program).

### `program-evm` (Solidity)
- **What it is:** The 3-contract EVM v1 set (`PactPool`, `PactSettler`, `PactRegistry`) — a Foundry project.
- **What it means:** The on-chain EVM law (Arc/Base) — counterpart of the Solana program.
- **What breaks without it:** The EVM branch is lost entirely.
- **Overlap:** None (counterpart, not a duplicate).
- **Depends on:** `protocol-evm-v1-client` maps to it.

---

## GROUP Z — Removed (historical note)

`wrap-v2` · `settler-v2` · `indexer-v2` · `db-v2` · `protocol-v2-client` — these 5 V2 directories were fully
deleted in commit `2b5cb0c`. No leftover directories remain; nothing to clean up.

---

## Overlap summary & cleanup priority (derived from the above)

| Priority | Task | Real verified scope |
|---|---|---|
| #0 ✅ DONE | Delete the 5 zombie V2 directories | Completed in `2b5cb0c` — the 5 V2 dirs were fully removed; no leftover dirs remain. |
| P1 | Consolidate the classifier | The **one** true copy = `backend/routes/monitor.ts:24` → import `monitor`. + write a **parity test** (never existed). `market-proxy` already imports `wrap`. Leave `cli` alone (different domain). |
| P2 | Merge the V2 client | **Half done** — `protocol-v2-client` is gone; only `insurance` remains. Remaining work: clean up the alias/notes; no longer "parallel". |
| P2.5 | Consolidate premium/refund economics | `facilitator/coverage.ts` `computeCoverage` duplicates `wrap` — missed by the old audit. Consider a separate issue (touches the money path). |
| P3 | Fence the legacy | Split the scorecard routes + V2/claims out of `backend`; share the `facilitator` contract with `cli` (D4). A later pass. |

> Classifier detail: see `ANALYSIS.md` in the issue #3 folder. `ARCHITECTURE.*` and `DIVERGENCE-AUDIT.*` were
> updated 2026-06-03 (`2b5cb0c`) to match — they no longer list the deleted V2 packages as live and already
> reflect the corrected D1/D2 findings.
