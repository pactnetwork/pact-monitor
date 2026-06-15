import type { FastifyInstance } from "fastify";
import { classifyHttpOutcome } from "@pact-network/classifier";
import { requireApiKey } from "../middleware/auth.js";
import { query, getOne } from "../db.js";

interface MonitorBody {
  url: string;
  method?: string;
}

async function findOrCreateProvider(hostname: string): Promise<string> {
  const existing = await getOne<{ id: string }>(
    "SELECT id FROM providers WHERE base_url = $1",
    [hostname],
  );
  if (existing) return existing.id;

  const created = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  return created!.id;
}

// Scorecard monitor classification. Shares the rails-core decision tree
// (@pact-network/classifier) with monitor's `classify`, then projects the
// neutral category onto the scorecard's classification vocabulary. Behavior is
// identical to monitor's classify called with a 5000ms threshold and no schema.
const SCORECARD_LATENCY_THRESHOLD_MS = 5000;

export function classify(statusCode: number, latencyMs: number, networkError: boolean): string {
  const category = classifyHttpOutcome({
    statusCode,
    latencyMs,
    latencyThresholdMs: SCORECARD_LATENCY_THRESHOLD_MS,
    networkError,
  });

  switch (category) {
    case "network_error":
    case "server_error":
    case "other":
      return "server_error";
    case "client_error":
      return "client_error";
    case "slow":
      return "timeout";
    case "success":
      return "success";
  }

  // Defensive total fallback. The switch above is exhaustive over CoreCategory's
  // six members, so this is unreachable today. It exists so `classify` stays
  // provably total (no implicit `undefined` return) even if @pact-network/classifier
  // adds a category or its types ever regress — mirrors the scorecard's
  // "treat unknown as a server-side failure" default.
  return "server_error";
}

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: MonitorBody }>(
    "/api/v1/monitor",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { url, method = "GET" } = request.body;

      if (!url) {
        return reply.code(400).send({ error: "url is required" });
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return reply.code(400).send({ error: "Invalid URL" });
      }

      const hostname = parsed.hostname;
      const endpoint = parsed.pathname;
      const start = Date.now();
      let statusCode = 0;
      let networkError = false;

      try {
        const res = await fetch(url, { method });
        statusCode = res.status;
      } catch {
        networkError = true;
      }

      const latencyMs = Date.now() - start;
      const classification = classify(statusCode, latencyMs, networkError);

      const agentId = (request as import("fastify").FastifyRequest & { agentId: string }).agentId;
      const providerId = await findOrCreateProvider(hostname);

      await query(
        `INSERT INTO call_records (
          provider_id, endpoint, timestamp, status_code, latency_ms,
          classification, agent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [providerId, endpoint, new Date().toISOString(), statusCode, latencyMs, classification, agentId],
      );

      return {
        status_code: statusCode,
        latency_ms: latencyMs,
        classification,
        provider: hostname,
        payment: null,
      };
    },
  );
}
