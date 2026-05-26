import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { initContext } from "./lib/context.js";
import { healthRoute, setHealthDeps } from "./routes/health.js";
import { proxyRoute } from "./routes/proxy.js";
import { agentsRoute } from "./routes/agents.js";
import { callsRoute } from "./routes/calls.js";
import { adminRoute } from "./routes/admin.js";
import { wellKnownEndpointsRoute } from "./routes/well-known.js";
import { verifyPactSignature } from "./middleware/verify-signature.js";
import { requireBetaKey } from "./middleware/require-beta-key.js";
import type { EndpointRegistry } from "./lib/endpoints.js";
import type { SystemFlagReader } from "./lib/system-flag.js";
import { env } from "./env.js";

export interface CreateAppDeps {
  pg: Pick<Pool, "query">;
  betaGateFlag: SystemFlagReader;
  registry: EndpointRegistry;
}

/**
 * Build the Hono app + `/v1/:slug/*` middleware pipeline. Extracted from
 * `main()` so the auth wiring (including the EVM/Solana cross-mode guard) is
 * testable without standing up Postgres / RPC / Pub/Sub.
 */
export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono();

  app.get("/health", healthRoute);
  app.get("/.well-known/endpoints", wellKnownEndpointsRoute);
  app.get("/v1/agents/:pubkey", agentsRoute);
  app.get("/v1/calls/:id", callsRoute);
  app.post("/admin/reload-endpoints", adminRoute);

  // Order matters on `/v1/:slug/*`:
  //   1. requireBetaKey    — short-circuits with 403 pact_auth_not_in_beta
  //      when the gate is on and the API key is missing/invalid. No-op when
  //      the SystemFlag `beta_gate_enabled` is off (default in dev/staging).
  //   2. verifyPactSignature — enforces the signature envelope when an
  //      `x-pact-agent` header is present (no-op otherwise). The auth mode is
  //      selected by the agent key format (a 0x EVM address verifies via
  //      secp256k1 / EIP-191; a bs58 pubkey via Ed25519) AND cross-checked
  //      against the endpoint's network: `getEndpointNetwork` maps
  //      slug -> registry -> network, so an agent whose VM does not match the
  //      endpoint (a 0x agent on a Solana endpoint, or an Ed25519 agent on an
  //      EVM endpoint) is rejected. An unknown slug -> undefined -> the guard
  //      falls back to key-format selection and proxyRoute 404s the unknown
  //      endpoint downstream.
  //   3. proxyRoute        — the insured proxy handler.
  app.use(
    "/v1/:slug/*",
    requireBetaKey({ pg: deps.pg, flag: deps.betaGateFlag }),
  );
  app.use(
    "/v1/:slug/*",
    verifyPactSignature({
      getEndpointNetwork: async (c) =>
        c.req.header("x-pact-network") ??
        (await deps.registry.get(c.req.param("slug") ?? ""))?.network,
    }),
  );
  app.all("/v1/:slug/*", proxyRoute);

  return app;
}

async function main(): Promise<void> {
  const ctx = await initContext();
  setHealthDeps({ registry: ctx.registry });

  const app = createApp({
    pg: ctx.pg,
    betaGateFlag: ctx.betaGateFlag,
    registry: ctx.registry,
  });

  const port = parseInt(env.PORT, 10);
  serve({ fetch: app.fetch, port });
  console.log(`pact-market-proxy listening on :${port}`);
}

// Only boot the server when run as the entrypoint (`node dist/index.js` /
// `tsx src/index.ts`). Importing this module — e.g. a test exercising
// `createApp` — must not start Postgres / RPC / Pub/Sub.
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error("startup error", err);
    process.exit(1);
  });
}
