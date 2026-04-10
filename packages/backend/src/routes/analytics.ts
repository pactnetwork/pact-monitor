import type { FastifyInstance } from "fastify";
import { query } from "../db.js";

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/analytics/events", async (request, reply) => {
    const { event_type, event_data, session_id, source } = request.body as {
      event_type?: string;
      event_data?: Record<string, unknown>;
      session_id?: string;
      source?: string;
    };

    if (!event_type || typeof event_type !== "string") {
      return reply.code(400).send({ error: "event_type is required" });
    }

    await query(
      "INSERT INTO analytics_events (event_type, event_data, session_id, source) VALUES ($1, $2, $3, $4)",
      [event_type, JSON.stringify(event_data || {}), session_id || null, source || "scorecard"],
    );

    return { accepted: true };
  });
}
