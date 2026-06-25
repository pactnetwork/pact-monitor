# CI Workflow Audit — agent-tasks#24

Audited 2026-06-18. Branch: `crew/ci-prune-24` → `develop`.

## Branch Protection

`gh api repos/pactnetwork/pact-monitor/branches/develop/protection` → **404 (no protection)**
`gh api repos/pactnetwork/pact-monitor/branches/main/protection` → **404 (no protection)**

Neither `develop` nor `main` has branch protection rules configured. There are **no required status checks** on either branch. All removals below are safe from a branch-protection standpoint.

## Decision Table

| Workflow | Trigger | Purpose | Last Run | Decision | Reason |
|---|---|---|---|---|---|
| `backend-tests.yaml` | push (develop/feat/fix/sre/chore), PR to develop/main (path-gated) | Backend + settler test suite against real Postgres 16 | 2026-06-18 ✅ | **KEEP** | Active CI gate; runs on every PR |
| `build-cli-manual.yaml` | `workflow_dispatch` only | Build pact-cli binary from any ref; upload artifact. QA + incident triage. | Never dispatched | **KEEP** | Zero auto-trigger cost; distinct purpose from `publish-cli` (binary vs npm, any ref vs main only) |
| `build-pact-network.yaml` | `workflow_dispatch` | Build one of 5 Cloud Run services (proxy/settler/indexer/dashboard/facilitator) → AR `pact-network` | 2026-06-04 ✅ | **KEEP** | Active build pipeline for all live pact-network services |
| `build.yaml` | `workflow_call` + `workflow_dispatch` | Build legacy `pact-monitor-backend` single service → AR `pact-monitor-backend`. Production explicitly blocked. | 2026-04-20 ✅ | **REMOVE** | Legacy pipeline replaced by `build-pact-network.yaml`. 2 months stale. Production path hard-errors. Only caller is `full-deploy.yaml` (also removed). |
| `cold-build.yaml` | push (develop/feat/fix/sre/chore), PR to develop/main (path-gated) | Simulates fresh `pnpm install && pnpm build` — catches monorepo build-ordering bugs | 2026-06-18 ✅ | **KEEP** | Active CI gate; distinct from backend-tests (compile-only, no DB) |
| `deploy-pact-network.yaml` | `workflow_dispatch` | Deploy one of 5 Cloud Run services from AR image. Includes INDEXER_PUSH_SECRET re-assertion guard. | 2026-05-12 ✅ | **KEEP** | Active deploy pipeline for all live pact-network services |
| `deploy.yaml` | `workflow_call` + `workflow_dispatch` | Deploy legacy `pact-monitor-backend`. Production explicitly blocked. | 2026-04-20 ✅ | **REMOVE** | Legacy pipeline replaced by `deploy-pact-network.yaml`. 2 months stale. Production path hard-errors. Only caller is `full-deploy.yaml` (also removed). |
| `full-deploy.yaml` | `workflow_dispatch` | Chain `build.yaml` → `deploy.yaml` for `pact-monitor-backend` in one dispatch | 2026-04-16 ❌ (cancelled) | **REMOVE** | Wrapper around the two removed legacy workflows. Last run was cancelled. Dead once `build.yaml`/`deploy.yaml` are removed. |
| `program-build.yaml` | push to main/develop/migrate/feat/fix (path-gated), PR (path-gated) | Pinocchio cargo host tests + mainnet artifact + test artifact with SBF toolchain | 2026-06-18 ✅ | **KEEP** | Active CI gate for on-chain program |
| `publish-cli.yaml` | push to main (path-gated on `packages/cli/**`) + `workflow_dispatch` | Publish `@q3labs/pact-cli` to npm with monotonicity guard + GH release | 2026-06-09 ✅ | **KEEP** | Active npm publish pipeline |
| `publish-insurance.yaml` | push to main (path-gated on `packages/insurance/**`) + `workflow_dispatch` | Publish `@q3labs/pact-insurance` to npm with monotonicity guard + GH release | 2026-06-09 ✅ | **KEEP** | Active npm publish pipeline |
| `publish-monitor.yaml` | push to main (path-gated on `packages/monitor/**`) + `workflow_dispatch` | Publish `@q3labs/pact-monitor` to npm with monotonicity guard + GH release | 2026-06-09 ✅ | **KEEP** | Active npm publish pipeline |
| `publish-sdk.yaml` | push to main (path-gated on `packages/sdk/**` + `packages/protocol-v1-client/**`) + `workflow_dispatch` | Publish `@q3labs/pact-protocol-v1-client` + `@q3labs/pact-sdk` to npm; external consumer smoke; GH release | 2026-06-09 ✅ | **KEEP** | Active npm publish pipeline (two-package coordinated publish) |
| `sync-skill.yaml` | push to main (path-gated on `.claude/skills/pact-network/**`), PR, `workflow_dispatch` | Validate skill field coverage; mirror `.claude/skills/pact-network/` to `solder-build/pact-skill` | 2026-05-04 ✅ | **KEEP** | Active operational workflow; distinct purpose |

## Removed Files

| File | Replacement |
|---|---|
| `build.yaml` | `build-pact-network.yaml` (active multi-service pipeline) |
| `deploy.yaml` | `deploy-pact-network.yaml` (active multi-service pipeline) |
| `full-deploy.yaml` | Run `build-pact-network.yaml` then `deploy-pact-network.yaml` in sequence |

## Overlap Analysis

**build vs build-pact-network vs cold-build vs program-build:**
- `build.yaml` — legacy `pact-monitor-backend` Docker build → AR (REMOVED)
- `build-pact-network.yaml` — active 5-service Docker build → AR (KEPT)
- `cold-build.yaml` — TypeScript compile smoke from clean clone, no Docker (KEPT, different concern)
- `program-build.yaml` — Rust/SBF on-chain program build, unrelated to Docker (KEPT, different concern)

**deploy vs deploy-pact-network:**
- `deploy.yaml` — legacy `pact-monitor-backend` Cloud Run deploy (REMOVED)
- `deploy-pact-network.yaml` — active 5-service Cloud Run deploy with INDEXER_PUSH_SECRET guard (KEPT)

**full-deploy:**
- `full-deploy.yaml` — `workflow_dispatch` convenience wrapper chaining the two removed legacy workflows (REMOVED)

## Notes for Captain / Rick

- `build-cli-manual.yaml` has never been dispatched. Zero cost to keep it; useful for QA binary testing from feature branches.
- The `INDEXER_PUSH_SECRET` re-assertion in `deploy-pact-network.yaml` is load-bearing (prevented a 2026-05-07 mainnet incident) — do not merge it into `build-pact-network.yaml`.
- `publish-insurance.yaml` still uses `--provenance` (unlike `publish-cli.yaml` and `publish-sdk.yaml` which dropped it for private-repo compat). Flagged by a TODO in the other files. Left as-is per surgical-change policy; separate issue.
