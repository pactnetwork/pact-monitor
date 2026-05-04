# Pact Market Changelog

## Phase 0 — 2026-05-04

Workspace scaffolded. New packages created:

- `packages/proxy` — Cloudflare Workers + Hono skeleton
- `packages/settler` — NestJS settlement worker skeleton
- `packages/indexer` — NestJS webhook indexer skeleton
- `packages/dashboard` — Next.js 15 App Router skeleton
- `packages/shared` — shared TypeScript types and constants
- `packages/db` — Prisma shared database package

Root changes:
- Added `turbo.json` with build/test/dev/lint pipeline
- Updated root `package.json` with turbo dev dep and turbo-based scripts
- Updated `tsconfig.base.json` with paths for all new packages
