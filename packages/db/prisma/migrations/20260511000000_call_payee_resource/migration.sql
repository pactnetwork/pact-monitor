-- Add nullable `payee` / `resource` columns to `Call` for pay.sh-covered
-- calls (source = "pay.sh"), populated by the indexer when it ingests a
-- settlement that the `facilitator.pact.network` service originated.
--
-- Both columns are NULL for gateway-path calls (source = "market-proxy" /
-- NULL), so this is a non-breaking additive migration — no backfill needed.
-- `payee` is a base58 Solana pubkey (≤44 chars, same width as agentPubkey);
-- `resource` is a URL (unbounded TEXT, like upstreamBase).
--
-- See packages/facilitator/ + docs/premium-coverage-mvp.md Part B.

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "payee" VARCHAR(44),
ADD COLUMN     "resource" TEXT;
