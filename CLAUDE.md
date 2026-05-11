# Pact Network

Pact Network is the on-chain risk layer for AI agent API payments on Solana. The protocol holds a coverage pool per insured endpoint, debits a small premium from the agent's USDC ATA on each call, and refunds the agent automatically when the call fails an SLA (latency, 5xx, network error). Every settlement happens on-chain with explicit per-recipient fee splits — most of the premium stays in the pool, a configurable cut goes to the network treasury, and another cut goes to the integrator who registered the endpoint.

**Pact Network = the rails.** On-chain program, fetch-call wrap library, settler, indexer, classifier protocol, Postgres schema, shared types. Generic. Anyone can build a curated marketplace, an SDK, or an x402-style facilitator on top of it.

**Pact Market = one interface on top of Pact Network.** The hosted Hono proxy at `market.pactnetwork.io` that wraps curated providers (Helius, Birdeye, Jupiter, Elfa, fal.ai), the Next.js dashboard at `dashboard.pactnetwork.io`, the demo allowlist, the brand surface. One opinionated product on top of the rails.

For the canonical architecture and build plan, see:
- `docs/superpowers/specs/2026-05-05-pact-market-execution-design.md` — execution-design spec
- `docs/superpowers/plans/2026-05-05-pact-market-v1.md` — Wave 0-5 implementation plan
- `docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md` — Network/Market layering + v1/v2 program rename refactor (the active plan)

## Tech Stack

- **Language:** TypeScript everywhere off-chain; Rust (Pinocchio 0.10) on-chain
- **On-chain:** Pinocchio program at `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` on devnet (v1)
- **Proxy:** Hono on Cloud Run (Node 22), `@hono/node-server`
- **Settler / Indexer:** NestJS on Cloud Run, Pub/Sub queue, Cloud SQL Postgres
- **Dashboard:** Next.js 15 (App Router), Tailwind 4, shadcn/ui, `@solana/wallet-adapter-react`
- **Solana client:** `@solana/web3.js` 1.x as workspace peerDep, `@solana/kit` 2.x where needed, hand-written Codama-style decoders in `@pact-network/protocol-v1-client`
- **Tooling:** pnpm workspaces, Turborepo, Vitest, LiteSVM (Bun), surfpool

## Monorepo Structure

```
packages/
  # Network rails — generic, can be consumed by any interface
  protocol-v1-client/  — @pact-network/protocol-v1-client: TS client for the v1 program (PDA helpers, instruction builders, account decoders, error map)
  wrap/                — @pact-network/wrap: generic fetch-call wrap library (wrapFetch, BalanceCheck, Classifier, EventSink, X-Pact-* headers)
  settler/             — @pact-network/settler: Pub/Sub → settle_batch submitter (NestJS)
  indexer/             — @pact-network/indexer: per-call indexer + read API + ops controller (NestJS)
  db/                  — @pact-network/db: Prisma schema for indexer (per-endpoint PoolState, Settlement, SettlementRecipientShare, RecipientEarnings)
  shared/              — @pact-network/shared: shared types, PDA seed constants, version

  # Pact Market — one curated interface on top of the rails
  market-proxy/        — @pact-network/market-proxy: Hono proxy wrapping Helius/Birdeye/Jupiter/Elfa/fal.ai (consumes @pact-network/wrap)
  market-dashboard/    — @pact-network/market-dashboard: Next.js dashboard for Pact Market

  # On-chain programs
  program/programs-pinocchio/pact-network-v1-pinocchio/  — V1: agent prepaid wallet via SPL Token approval, per-endpoint pools, interchangeable fee recipients (Treasury + Affiliates), pool-as-residual settlement
  program/programs-pinocchio/pact-network-v2-pinocchio/  — V2 (future): multi-underwriter parametric insurance with oracle-derived rates and claim filings (currently unchanged from pre-Step-A; not on the May 11 ship)
  program/programs/pact-insurance/                       — LEGACY Anchor V2 crate; rollback fallback only; do not modify

  # Pre-Step-A packages (still active for the public scorecard / SDK demo)
  monitor/      — @q3labs/pact-monitor: TS SDK wrapping fetch() for reliability monitoring
  insurance/    — @q3labs/pact-insurance: TS SDK for the v2 (legacy) on-chain insurance program; will be aliased to @pact-network/protocol-v2-client in a follow-up
  backend/      — @pact-network/backend: Fastify API server for the public scorecard
  scorecard/    — @pact-network/scorecard: Vite+React dashboard for provider reliability rankings
  sdk/          — older agent-side SDK (separate from monitor/insurance)
deploy/         — Docker Compose + Caddyfile + Cloud Run YAML
docs/           — PRD, specs, implementation plans (see top of this file)
samples/        — Sample agent integrations and demos
```

## Design System

- **Background:** #151311 (dark)
- **Copper:** #B87333 (financial values, insurance rates, network treasury)
- **Burnt Sienna:** #C9553D (failures, violations, HIGH RISK, pool depleted)
- **Slate:** #5A6B7A (healthy, RELIABLE states, settled)
- **Fonts:** Inria Serif (headlines), Inria Sans (body), JetBrains Mono (data)
- **Aesthetic:** Brutalist — zero/minimal border radius, no gradients, no emojis in code or UI

## Build & Run

This is a `pnpm` + `turbo` workspace. Use `pnpm`, not `npm`.

```bash
# Install all workspace dependencies
pnpm install

# Build everything
pnpm -r build

# Build a specific package
pnpm --filter @pact-network/protocol-v1-client build
pnpm --filter @pact-network/wrap build
pnpm --filter @pact-network/market-proxy build
pnpm --filter @pact-network/market-dashboard build

# Test
pnpm -r test

# On-chain program build (Pinocchio)
cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
cargo build-sbf --features bpf-entrypoint
# → target/deploy/pact_network_v1.so (~73 KB)

# On-chain LiteSVM tests
cd packages/program/programs-pinocchio/pact-network-v1-pinocchio
bun install && bun test tests/*.test.ts

# Dashboard dev server
pnpm --filter @pact-network/market-dashboard dev   # Next.js on :3000

# Settler / indexer dev (need Postgres running for indexer)
pnpm --filter @pact-network/settler dev
pnpm --filter @pact-network/indexer dev
```

## Devnet program

- **Program ID:** `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` (deployed 2026-05-05)
- **ProgramData:** `2YETBtKq1DnxCVEHwKRmTjmesq6pA84Q8TBquqeHEapy`
- **Upgrade authority (devnet):** `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` — devnet hot key; rotate to multisig before mainnet flip
- **Program-ID keypair:** `~/.config/solana/pact-network-v1-program-keypair.json` (back up off-box before mainnet)
- **IDL:** published on-chain via `anchor idl init` — see PR #67
- **Orphan (do not target):** `DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc` — pre-Step-C binary; original upgrade authority lost

## API endpoints

### Pact Market proxy (`market.pactnetwork.io`)
- `ALL /v1/:slug/*` — insured proxy to upstream API (per-call premium debit + on-breach refund)
- `GET /v1/agents/:pubkey` — read-only agent insurable-state snapshot
- `GET /health` — liveness
- `POST /admin/reload-endpoints` — bearer-token gated; clears in-memory caches

### Pact Network indexer (`indexer.pactnetwork.io`)
- `POST /events` — bearer-gated, idempotent settlement event ingest from settler
- `GET /api/stats` — aggregate-across-pools (pool totals, treasury earned, top integrators) — 5s cache
- `GET /api/endpoints`, `/api/endpoints/:slug`
- `GET /api/agents/:pubkey`, `/api/agents/:pubkey/calls?limit=N`
- `GET /api/calls/:id`
- `POST /api/ops/{pause,update-config,topup,update-fee-recipients}` — operator-allowlist gated; nacl signed-message verify; returns unsigned-tx for wallet signing

### Public scorecard (legacy, `pactnetwork.io`)
- `POST /api/v1/records` — batch ingest call records (authenticated)
- `GET /api/v1/providers` — list providers ranked by reliability
- `GET /api/v1/providers/:id` — provider detail
- `GET /api/v1/providers/:id/timeseries`
- `GET /api/v1/analytics/summary`, `/api/v1/analytics/timeseries`
- `GET /api/v1/claims` — claim records (legacy V2 product)
- `GET /health`

## Conventions

- **No emojis in code or UI.**
- **Conventional commits** for all messages (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`).
- **`pnpm`, not `npm`.**
- **Time estimates** in plans/tasks: omit human-paced estimates; AI execution is much faster. List steps and dependencies, not clock time.
- **Mainnet flip:** May 11, 2026 (Colosseum submission). Wed May 6 = public devnet end-to-end demo gate. **NB:** the mainnet readiness audit at `docs/audits/2026-05-05-mainnet-readiness.md` is currently BLOCKED FOR MAINNET pending multisig rotation, third-party audit, and protocol-wide pause — see audit for full punch list.
- **Authority rotation before mainnet:** the devnet upgrade authority is a hot key on the deployer's box. Run `solana program set-upgrade-authority` against a Squads multisig before any mainnet deploy.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pact-network** (3290 symbols, 7314 relationships, 245 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/pact-network/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pact-network/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pact-network/clusters` | All functional areas |
| `gitnexus://repo/pact-network/processes` | All execution flows |
| `gitnexus://repo/pact-network/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## GitNexus — Worktree gotcha (read me before running analyze)

> This section lives **outside** the `gitnexus:start`…`gitnexus:end` markers on
> purpose. Anything inside those markers gets regenerated from a hardcoded
> template every time `gitnexus analyze` runs — our own notes would be wiped.

`gitnexus analyze` derives the project name from `path.basename(repoPath)` and
regenerates both `CLAUDE.md` and `AGENTS.md` between the marker blocks. If you
run it from a git worktree (e.g. `../pact-network-feature-x`), every
`pact-network` reference inside the block is rewritten to the worktree
directory's basename, silently corrupting the agent instructions for the next
committer.

**Rules for this repo:**
- Only run `gitnexus analyze` from the primary checkout at `.../pact-network`,
  where `path.basename` already equals `pact-network`.
- If you're working in a worktree, **skip the refresh** — the user-level
  PostToolUse hook will still kick off `gitnexus analyze` after any commit in
  that worktree, so assume `CLAUDE.md` / `AGENTS.md` will be dirty and
  `git checkout --` them before pushing.
- Never commit a `CLAUDE.md` / `AGENTS.md` diff whose only change is the
  project-name token swapping to a worktree directory name — revert it.
