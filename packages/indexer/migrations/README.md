# Migrations

Prisma manages migrations for this service via `@pact-network/db`.

Run from repo root:

```bash
pnpm --filter @pact-network/db db:migrate:dev   # create migration
pnpm --filter @pact-network/db db:migrate       # apply
```
