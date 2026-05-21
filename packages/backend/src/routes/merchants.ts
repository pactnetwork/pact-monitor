/**
 * Merchant-discovery + per-merchant stats routes.
 *
 *   GET /api/v1/merchants            — public registry the agent SDK caches
 *                                       (E5) to verify X-Pact-Proxied-By
 *                                       attestations. Backed by the
 *                                       v_active_merchants view (active
 *                                       merchant api_keys × their registered
 *                                       hostnames).
 *   GET /api/v1/merchants/me/stats   — merchant-only zeroed stats so SDK
 *                                       `merchant.stats()` never 404s.
 *                                       (Real aggregation lands in Commit 3.)
 *
 * ETag is a real sha256 of the body — the agent SDK's If-None-Match cache
 * sees a cache miss whenever the merchant set changes.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireRole } from "../middleware/auth.js";
import { getMany } from "../db.js";

export async function merchantsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/merchants", async (request, reply) => {
    const rows = await getMany<{
      merchant_pubkey: string;
      label: string;
      hostnames: string[] | null;
    }>(
      "SELECT merchant_pubkey, label, hostnames FROM v_active_merchants",
    );
    const merchants = rows.map((r) => ({
      pubkey: r.merchant_pubkey,
      label: r.label,
      // ARRAY_AGG with the FILTER clause returns NULL when no active
      // hostnames exist — normalize to [] for a stable client shape.
      hostnames: r.hostnames ?? [],
    }));
    // ETag is keyed on the CONTENT only — generatedAt is metadata and
    // changes per request, which would otherwise defeat If-None-Match
    // (cache miss on every call).
    const etag = `"${createHash("sha256").update(JSON.stringify(merchants)).digest("hex").slice(0, 16)}"`;
    const body = { merchants, generatedAt: new Date().toISOString() };
    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      reply.code(304).send();
      return;
    }
    reply.header("ETag", etag);
    reply.header("Cache-Control", "public, max-age=60");
    return body;
  });

  app.get(
    "/api/v1/merchants/me/stats",
    { preHandler: [requireApiKey, requireRole("merchant")] },
    async () => {
      // Commit 1 zeroed shape — matches the bigint-as-string contract that
      // the SDK's stats.ts decoder expects.
      return {
        calls: 0,
        failureRate: 0,
        tier: "UNRANKED",
        premiumsCollectedUsdc: "0",
        refundsPaidUsdc: "0",
        netRevenueUsdc: "0",
      };
    },
  );
}
