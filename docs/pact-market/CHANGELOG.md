# Pact Market Changelog

## Phase 0 — 2026-05-04

Workspace scaffolded. New packages created:

- `packages/market-proxy` (formerly `packages/proxy`) — Hono on Cloud Run + `@pact-network/wrap` consumer
- `packages/settler` — NestJS settlement worker skeleton
- `packages/indexer` — NestJS webhook indexer skeleton
- `packages/market-dashboard` (formerly `packages/dashboard`) — Next.js 15 App Router skeleton
- `packages/shared` — shared TypeScript types and constants
- `packages/db` — Prisma shared database package

Root changes:
- Added `turbo.json` with build/test/dev/lint pipeline
- Updated root `package.json` with turbo dev dep and turbo-based scripts
- Updated `tsconfig.base.json` with paths for all new packages

## Step B — 2026-05-05

Network/Market layering refactor:
- Renamed `packages/proxy` → `packages/market-proxy` (`@pact-network/proxy` → `@pact-network/market-proxy`)
- Renamed `packages/dashboard` → `packages/market-dashboard` (`@pact-network/dashboard` → `@pact-network/market-dashboard`)
- Added `packages/wrap` (`@pact-network/wrap`) — Network-core fetch-call wrap library
