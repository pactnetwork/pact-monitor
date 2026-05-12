import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { healthRoute, setHealthDeps } from "./routes/health.js";
import { wellKnownPayCoverageRoute } from "./routes/well-known.js";
import {
  registerCoverageRoute,
  getCoverageRoute,
} from "./routes/coverage.js";
import { verifyPactSignature } from "./middleware/verify-signature.js";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", healthRoute);
  app.get("/.well-known/pay-coverage", wellKnownPayCoverageRoute);
  app.get("/v1/coverage/:id", getCoverageRoute);
  // verifyPactSignature REQUIRES a valid ed25519 envelope here (no demo path).
  app.use("/v1/coverage/register", verifyPactSignature());
  app.post("/v1/coverage/register", registerCoverageRoute);

  return app;
}

async function main(): Promise<void> {
  // Imported lazily so importing this module (e.g. from tests that only want
  // createApp + a mocked context) never triggers env-var parsing.
  const { env } = await import("./env.js");
  const { initContext } = await import("./lib/context.js");
  initContext();
  setHealthDeps({ payDefaultSlug: env.PAY_DEFAULT_SLUG });

  const app = createApp();
  const port = parseInt(env.PORT, 10);
  serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log(`pact-facilitator listening on :${port}`);
}

// Only auto-start when run as the entrypoint (not when imported by tests).
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("startup error", err);
    process.exit(1);
  });
}
