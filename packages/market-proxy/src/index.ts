import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { initContext } from "./lib/context.js";
import { healthRoute, setHealthDeps } from "./routes/health.js";
import { proxyRoute } from "./routes/proxy.js";
import { agentsRoute } from "./routes/agents.js";
import { adminRoute } from "./routes/admin.js";
import { env } from "./env.js";

const app = new Hono();

app.get("/health", healthRoute);
app.get("/v1/agents/:pubkey", agentsRoute);
app.all("/v1/:slug/*", proxyRoute);
app.post("/admin/reload-endpoints", adminRoute);

async function main(): Promise<void> {
  const ctx = await initContext();
  setHealthDeps({ registry: ctx.registry, balanceCache: ctx.balanceCache });

  const port = parseInt(env.PORT, 10);
  serve({ fetch: app.fetch, port });
  console.log(`pact-proxy listening on :${port}`);
}

main().catch((err) => {
  console.error("startup error", err);
  process.exit(1);
});
