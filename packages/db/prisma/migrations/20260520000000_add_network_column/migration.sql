-- WP-MN-03a T3: Add `network` column to 6 tables with composite primary keys.
--
-- Strategy (per RESEARCH §4.2):
--   1. Add `network VARCHAR(24) NOT NULL DEFAULT 'solana-devnet'` to all 6 tables.
--      Postgres applies the DEFAULT to all existing rows in the same DDL transaction
--      (no separate backfill step needed — the column is NOT NULL with a default).
--   2. Drop old single-column PKs; add composite (network, X) PKs.
--   3. Drop old single-column indexes that don't filter by network; add network-prefixed
--      composite indexes on the query-path hot paths.
--   4. Update FK constraints to reference the composite PKs.
--
-- Tables affected: Call, Endpoint, PoolState, RecipientEarnings, Settlement,
--   SettlementRecipientShare (keeps its cuid `id` PK; network added as field + FK).
-- Tables NOT affected: Agent (wallet-identity is network-agnostic).
--
-- Safe: no DROP COLUMN, no DROP TABLE, no data-loss operation.
-- Production deploy: run `prisma migrate deploy` in lockstep with the service
--   re-deploy that updates events.service.ts composite-key upserts (T4).

-- DropForeignKey
ALTER TABLE "Call" DROP CONSTRAINT "Call_endpointSlug_fkey";

-- DropForeignKey
ALTER TABLE "PoolState" DROP CONSTRAINT "PoolState_endpointSlug_fkey";

-- DropForeignKey
ALTER TABLE "SettlementRecipientShare" DROP CONSTRAINT "SettlementRecipientShare_settlementSig_fkey";

-- DropIndex
DROP INDEX "Call_agentPubkey_ts_idx";

-- DropIndex
DROP INDEX "Call_breach_ts_idx";

-- DropIndex
DROP INDEX "Call_endpointSlug_ts_idx";

-- DropIndex
DROP INDEX "SettlementRecipientShare_recipientPubkey_idx";

-- DropIndex
DROP INDEX "SettlementRecipientShare_settlementSig_idx";

-- AlterTable: Call — add network, promote PK to composite (network, callId)
ALTER TABLE "Call" DROP CONSTRAINT "Call_pkey",
ADD COLUMN     "network" VARCHAR(24) NOT NULL DEFAULT 'solana-devnet',
ADD CONSTRAINT "Call_pkey" PRIMARY KEY ("network", "callId");

-- AlterTable: Endpoint — add network, promote PK to composite (network, slug)
ALTER TABLE "Endpoint" DROP CONSTRAINT "Endpoint_pkey",
ADD COLUMN     "network" VARCHAR(24) NOT NULL DEFAULT 'solana-devnet',
ADD CONSTRAINT "Endpoint_pkey" PRIMARY KEY ("network", "slug");

-- AlterTable: PoolState — add network, promote PK to composite (network, endpointSlug)
ALTER TABLE "PoolState" DROP CONSTRAINT "PoolState_pkey",
ADD COLUMN     "network" VARCHAR(24) NOT NULL DEFAULT 'solana-devnet',
ADD CONSTRAINT "PoolState_pkey" PRIMARY KEY ("network", "endpointSlug");

-- AlterTable: RecipientEarnings — add network, promote PK to composite (network, recipientPubkey)
ALTER TABLE "RecipientEarnings" DROP CONSTRAINT "RecipientEarnings_pkey",
ADD COLUMN     "network" VARCHAR(24) NOT NULL DEFAULT 'solana-devnet',
ADD CONSTRAINT "RecipientEarnings_pkey" PRIMARY KEY ("network", "recipientPubkey");

-- AlterTable: Settlement — add network, promote PK to composite (network, signature)
ALTER TABLE "Settlement" DROP CONSTRAINT "Settlement_pkey",
ADD COLUMN     "network" VARCHAR(24) NOT NULL DEFAULT 'solana-devnet',
ADD CONSTRAINT "Settlement_pkey" PRIMARY KEY ("network", "signature");

-- AlterTable: SettlementRecipientShare — add network (keeps cuid id PK; FK updated below)
ALTER TABLE "SettlementRecipientShare" ADD COLUMN     "network" VARCHAR(24) NOT NULL DEFAULT 'solana-devnet';

-- CreateIndex: network-prefixed composite indexes replacing old single-column ones
CREATE INDEX "Call_network_agentPubkey_ts_idx" ON "Call"("network", "agentPubkey", "ts" DESC);

CREATE INDEX "Call_network_endpointSlug_ts_idx" ON "Call"("network", "endpointSlug", "ts" DESC);

CREATE INDEX "Call_network_breach_ts_idx" ON "Call"("network", "breach", "ts" DESC);

CREATE INDEX "SettlementRecipientShare_network_recipientPubkey_idx" ON "SettlementRecipientShare"("network", "recipientPubkey");

CREATE INDEX "SettlementRecipientShare_network_settlementSig_idx" ON "SettlementRecipientShare"("network", "settlementSig");

-- AddForeignKey: Call → Endpoint (composite)
ALTER TABLE "Call" ADD CONSTRAINT "Call_network_endpointSlug_fkey" FOREIGN KEY ("network", "endpointSlug") REFERENCES "Endpoint"("network", "slug") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: SettlementRecipientShare → Settlement (composite)
ALTER TABLE "SettlementRecipientShare" ADD CONSTRAINT "SettlementRecipientShare_network_settlementSig_fkey" FOREIGN KEY ("network", "settlementSig") REFERENCES "Settlement"("network", "signature") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: PoolState → Endpoint (composite)
ALTER TABLE "PoolState" ADD CONSTRAINT "PoolState_network_endpointSlug_fkey" FOREIGN KEY ("network", "endpointSlug") REFERENCES "Endpoint"("network", "slug") ON DELETE RESTRICT ON UPDATE CASCADE;
