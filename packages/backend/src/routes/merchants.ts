/**
 * Merchant-discovery + per-merchant stats routes (Commit 1 stubs).
 *
 *   GET /api/v1/merchants            — public registry the agent SDK caches
 *                                       (E5) to verify X-Pact-Proxied-By
 *                                       attestations. Empty list in Commit 1;
 *                                       v_active_merchants lands in Commit 2.
 *   GET /api/v1/merchants/me/stats   — merchant-only zeroed stats so SDK
 *                                       `merchant.stats()` never 404s.
 *
 * ETag on the public list is a real sha256 of the body, NOT a static
 * sentinel — when Commit 2 populates real merchants, the agent SDK's
 * If-None-Match cache immediately starts seeing cache misses on changes.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireRole } from "../middleware/auth.js";

export async function merchantsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/merchants", async (request, reply) => {
    const body = {
      merchants: [] as Array<{
        pubkey: string;
        label: string;
        hostnames: string[];
      }>,
      generatedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(body);
    const etag = `"${createHash("sha256").update(json).digest("hex").slice(0, 16)}"`;
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
