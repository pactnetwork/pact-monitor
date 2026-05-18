/**
 * /metrics — Prometheus scrape endpoint.
 *
 * Today this exposes the GoldRush verification counter + latency histogram
 * (Step 5 of the GoldRush customer-PoC brief). Any future prom-client
 * instrumentation in this process auto-registers against the same default
 * registry and shows up here.
 *
 * No auth: scrape endpoints are conventionally unauth'd and gated at the
 * network layer. Backend Cloud Run already restricts ingress; in dev this
 * is reachable from localhost only.
 */
import type { FastifyInstance } from "fastify";
import { goldrushRegistry } from "../services/goldrush-metrics.js";

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", goldrushRegistry.contentType);
    return goldrushRegistry.metrics();
  });
}
