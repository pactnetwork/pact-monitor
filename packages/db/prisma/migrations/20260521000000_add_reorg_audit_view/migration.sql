-- WP-MN-04 T3 — settlement_reorg_audit read-only view.
-- LOCAL DOCKER ONLY per Tu's directive (2026-05-20).
-- Production deploy is a separate ops step.
CREATE OR REPLACE VIEW "settlement_reorg_audit" AS
SELECT
  c.network,
  c."callId",
  c.signature,
  c."premiumLamports" AS amount,
  c."settledAt"        AS "detectedAt"
FROM "Call" c
WHERE FALSE;
-- The static FALSE means the view is empty in production; the indexer's
-- ReorgService writes detected orphans into a separate audit table (NOT
-- this view) in a follow-up WP. For T3 the view is a schema-shape
-- placeholder so Prisma type-generation produces the right TS types.
