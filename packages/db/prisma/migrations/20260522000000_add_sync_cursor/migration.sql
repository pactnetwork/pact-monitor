-- Multi-EVM WP T3: per-network config-sync cursor.
--
-- Lets the indexer's 5-min EndpointConfig refresh resume its EndpointRegistered
-- log scan from the last finalized block it scanned, instead of re-walking from
-- `deploymentBlock` every tick (cost otherwise scales with chain HEIGHT).
--
-- `lastScannedBlock` is the highest finalized block fully scanned in the last
-- successful pass; the next pass resumes at `lastScannedBlock + 1`. Cold start
-- (no row) walks from the chain's `deploymentBlock`.
--
-- Additive only: new table, no data-loss operation. Apply with
-- `prisma migrate deploy` against a LOCAL docker Postgres (and, separately, the
-- ops-owned remote per Tu's directive) — never point this at prod directly.

-- CreateTable
CREATE TABLE "SyncCursor" (
    "network" VARCHAR(24) NOT NULL,
    "lastScannedBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("network")
);
