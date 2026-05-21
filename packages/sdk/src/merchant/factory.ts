/**
 * `createPactMerchant()` — the merchant-side factory. Mirrors `createPact`
 * in lifecycle (sync handlers, shutdown escape hatch) but provides the
 * merchant surface: middleware adapters, manual observe, register/dispute/
 * stats/referrals.
 *
 * Auto Mode note: integrators get a working SDK in Commit 1 even before the
 * full backend lands — observations persist as `origin='merchant'`, stats
 * return zeros, dispute/referrals throw typed NOT_AVAILABLE.
 */
import {
  validateMerchantConfig,
  type MerchantConfig,
  type ResolvedMerchantConfig,
} from "./config.js";
import { resolveNetwork } from "../network.js";
import { resolveSecretKey } from "../signer.js";
import { createMerchantClient, type MerchantClient } from "./client.js";
import { observe, type ObservationInput, type ObservationResult } from "./observe.js";
import {
  registerEndpoint,
  type RegisterInput,
  type RegisterResult,
} from "./register.js";
import { fetchStats, type MerchantStats } from "./stats.js";
import {
  fileDispute,
  type DisputeInput,
  type DisputeResult,
} from "./disputes.js";
import {
  buildReferralLink,
  fetchReferrals,
  type MerchantReferrals,
} from "./referrals.js";
import { createExpressMiddleware } from "./middleware/express.js";
import { createFastifyPlugin } from "./middleware/fastify.js";
import { createHonoMiddleware } from "./middleware/hono.js";
import type { MiddlewareDeps, MiddlewareOptions } from "./middleware/shared.js";

// Re-export aggregate types for the public API surface.
export type {
  MerchantConfig,
  ObservationInput,
  ObservationResult,
  RegisterInput,
  RegisterResult,
  MerchantStats,
  DisputeInput,
  DisputeResult,
  MerchantReferrals,
  MiddlewareOptions,
};
export type { PricingMap, ClassifyResponseFn } from "./middleware/shared.js";

export interface MerchantInstance {
  readonly merchantPubkey: string;
  /** Express middleware. */
  middleware(opts: MiddlewareOptions): ReturnType<typeof createExpressMiddleware>;
  /**
   * Fastify hook installer. Apply with `await m.fastify(opts)(app)`. The
   * hooks attach to the app directly (no encapsulation) so they cover every
   * route on that instance.
   */
  fastify(opts: MiddlewareOptions): ReturnType<typeof createFastifyPlugin>;
  /** Hono middleware (use with `app.use('*', ...)`). */
  hono(opts: MiddlewareOptions): ReturnType<typeof createHonoMiddleware>;
  observe(input: ObservationInput): Promise<ObservationResult>;
  register(input: RegisterInput): Promise<RegisterResult>;
  dispute(input: DisputeInput): Promise<DisputeResult>;
  stats(opts?: { since?: number }): Promise<MerchantStats>;
  referrals(opts?: { since?: number }): Promise<MerchantReferrals>;
  referralLink(): string;
  shutdown(): Promise<void>;
}

interface FactoryDepsForTests {
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export async function createPactMerchant(
  rawConfig: MerchantConfig,
  testDeps?: FactoryDepsForTests,
): Promise<MerchantInstance> {
  const config: ResolvedMerchantConfig = validateMerchantConfig(rawConfig);
  const net = resolveNetwork(config.network, { backendBaseUrl: config.backendUrl });
  const client: MerchantClient = createMerchantClient({
    signer: config.signer,
    apiKey: config.apiKey,
    backendUrl: net.backendBaseUrl,
    fetchImpl: testDeps?.fetchImpl,
  });
  const secretKey = resolveSecretKey(config.signer);

  const deps: MiddlewareDeps = {
    client,
    merchantPubkey: client.merchantPubkey,
    secretKey,
    hostname: config.hostname,
  };

  // Lifecycle: a single shutdown flag flips on graceful exit. The backend
  // client itself is stateless (no batching timer in Commit 1) so shutdown
  // is mostly a no-op — kept for parity with createPact() and to give
  // Commit 2's batching path a place to flush.
  let shuttingDown = false;
  const signalHandlers: Array<{ sig: NodeJS.Signals | "beforeExit"; fn: () => void }> = [];

  function installHandlers(): void {
    if (!config.installSignalHandlers) return;
    const onSig = () => {
      shuttingDown = true;
    };
    const beforeExit = () => {
      shuttingDown = true;
    };
    process.on("SIGTERM", onSig);
    process.on("SIGINT", onSig);
    process.on("beforeExit", beforeExit);
    signalHandlers.push(
      { sig: "SIGTERM", fn: onSig },
      { sig: "SIGINT", fn: onSig },
      { sig: "beforeExit", fn: beforeExit },
    );
  }
  installHandlers();

  return {
    merchantPubkey: client.merchantPubkey,
    middleware: (opts) => createExpressMiddleware(deps, opts),
    fastify: (opts) => createFastifyPlugin(deps, opts),
    hono: (opts) => createHonoMiddleware(deps, opts),
    observe: (input) => observe(client, config.hostname, input),
    register: (input) => registerEndpoint(client, config.hostname, input),
    dispute: (input) => fileDispute(input),
    stats: (opts) => fetchStats(client, opts),
    referrals: (opts) => fetchReferrals(opts),
    referralLink: () => buildReferralLink(client.merchantPubkey),
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const h of signalHandlers) {
        process.removeListener(h.sig as NodeJS.Signals, h.fn);
      }
    },
  };
}
