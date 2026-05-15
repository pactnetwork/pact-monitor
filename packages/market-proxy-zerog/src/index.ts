// Pact-0G market proxy entrypoint (Hono / @hono/node-server, ESM).
//
//   GET  /health                — liveness + served slugs
//   GET  /v1/agents/:address    — ERC20 balance + allowance snapshot
//   ALL  /v1/:slug/*            — insured 0G-Compute proxy (ECDSA auth)
//
// Route order mirrors the Solana market-proxy: the agents GET is registered
// before the `/v1/:slug/*` auth middleware + catch-all so it is not captured
// as slug="agents".

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HEADERS } from '@pact-network/wrap';
import { parseEnv, type EnvType } from './env.js';
import { initContext } from './context.js';
import { verifyPactSignature } from './auth.js';
import { healthRoute } from './routes/health.js';
import { agentsRoute } from './routes/agents.js';
import { proxyRoute } from './routes/proxy.js';

const EXPOSED_HEADERS = [
  ...Object.values(HEADERS),
  'X-Pact-Call-Id',
  'x-zerog-chat-id',
  'x-zerog-tee-verified',
];

/** Pure wiring — no `initContext`, no `serve`. Testable via `app.request`. */
export function createApp(): Hono {
  const app = new Hono();
  // 5.C — the browser demo-runner makes direct fetch calls; without CORS +
  // exposed X-Pact-*/x-zerog-* headers it cannot read the insurance result.
  app.use('*', cors({ origin: '*', exposeHeaders: EXPOSED_HEADERS }));
  app.get('/health', healthRoute);
  app.get('/v1/agents/:address', agentsRoute);
  app.use('/v1/:slug/*', verifyPactSignature());
  app.all('/v1/:slug/*', proxyRoute);
  return app;
}

export async function main(env: EnvType = parseEnv()): Promise<void> {
  await initContext(env);
  const app = createApp();
  serve({ fetch: app.fetch, port: env.PORT });
}

// Auto-start only when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('market-proxy-zerog failed to start:', err);
    process.exit(1);
  });
}
