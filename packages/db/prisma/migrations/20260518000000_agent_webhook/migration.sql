-- Per-agent refund-push webhook registration on `Agent`.
--
-- The indexer POSTs each agent's just-settled calls to `webhookUrl`, signed
-- ed25519 with the indexer's key (the agent verifies a pinned indexer
-- pubkey — there is intentionally NO per-agent shared secret column). The URL
-- is registered via a bs58-ed25519 signed `POST /api/agents/:pubkey/webhook`
-- (same scheme the market-proxy verifies agents with).
--
-- All columns are NULL or defaulted → non-breaking additive migration, no
-- backfill. `webhookUrl` is an https URL (unbounded TEXT like Endpoint.upstreamBase);
-- `webhookFailCount` drives the chronically-failing-endpoint circuit breaker.
--
-- Dir name follows the repo's `YYYYMMDD000000_<name>` convention (NOT prisma's
-- auto `YYYYMMDDHHMMSS`). Applied in prod via `prisma migrate deploy` BEFORE
-- the new indexer image rolls.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "webhookUrl" TEXT,
ADD COLUMN     "webhookRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "webhookFailCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "webhookLastDeliveryAt" TIMESTAMP(3);
