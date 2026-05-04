# @pact-network/db

Shared Prisma database package for Pact Market services.

## Usage

1. Set `PG_URL` environment variable
2. Run `pnpm db:migrate` to apply migrations
3. Import `PrismaClient` from this package in settler/indexer

## Migrations

Migrations live in `prisma/migrations/`. Run with:

```bash
pnpm --filter @pact-network/db db:migrate:dev   # dev: creates migration files
pnpm --filter @pact-network/db db:migrate       # prod: apply existing migrations
```
