import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { initContext } from "./lib/context.js";
import { healthRoute, setHealthDeps } from "./routes/health.js";
import { proxyRoute } from "./routes/proxy.js";
import { agentsRoute } from "./routes/agents.js";
import { callsRoute } from "./routes/calls.js";
import { adminRoute } from "./routes/admin.js";
import { wellKnownEndpointsRoute } from "./routes/well-known.js";
import { verifyPactSignature } from "./middleware/verify-signature.js";
import { requireBetaKey } from "./middleware/require-beta-key.js";
import { env } from "./env.js";

const app = new Hono();

app.get("/health", healthRoute);
app.get("/.well-known/endpoints", wellKnownEndpointsRoute);
app.get("/v1/agents/:pubkey", agentsRoute);
app.get("/v1/calls/:id", callsRoute);
app.post("/admin/reload-endpoints", adminRoute);

async function main(): Promise<void> {
  const ctx = await initContext();
  setHealthDeps({ registry: ctx.registry });

  // Order matters on `/v1/:slug/*`:
  //   1. requireBetaKey    — short-circuits with 403 pact_auth_not_in_beta
  //      when the gate is on and the API key is missing/invalid. No-op
  //      when the SystemFlag `beta_gate_enabled` is off (current default
  //      in dev/staging).
  //   2. verifyPactSignature — enforces the ed25519 signature envelope
  //      when an `x-pact-agent` header is present (no-op otherwise).
  //   3. proxyRoute        — the insured proxy handler.
  //
  // Registration is deferred to main() so the middleware can capture the
  // pg pool + SystemFlagReader from `initContext()`. Other routes
  // (health, well-known, agents, calls, admin) stay top-level since they
  // don't depend on the gate.
  app.use(
    "/v1/:slug/*",
    requireBetaKey({ pg: ctx.pg, flag: ctx.betaGateFlag }),
  );
  // verifyPactSignature is a no-op when no x-pact-agent header is present
  // (e.g. dashboard demo via ?pact_wallet=...); otherwise it enforces a
  // valid ed25519 signature before the request reaches proxyRoute.
  app.use("/v1/:slug/*", verifyPactSignature());
  app.all("/v1/:slug/*", proxyRoute);

  const port = parseInt(env.PORT, 10);
  serve({ fetch: app.fetch, port });
  console.log(`pact-market-proxy listening on :${port}`);
}

main().catch((err) => {
  console.error("startup error", err);
  process.exit(1);
});
