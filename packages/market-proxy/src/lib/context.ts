import { Pool } from "pg";
import type { BalanceCheck, EventSink } from "@pact-network/wrap";
import { EndpointRegistry } from "./endpoints.js";
import { Allowlist } from "./allowlist.js";
import { createBalanceCheck } from "./balance.js";
import { createPubSubSink } from "./events.js";
import { createSystemFlagReader, type SystemFlagReader } from "./system-flag.js";
import { env } from "../env.js";

export interface AppContext {
  registry: EndpointRegistry;
  demoAllowlist: Allowlist;
  operatorAllowlist: Allowlist;
  balanceCheck: BalanceCheck;
  sink: EventSink;
  pg: Pool;
  betaGateFlag: SystemFlagReader;
}

let _ctx: AppContext | null = null;

export function getContext(): AppContext {
  if (!_ctx) throw new Error("AppContext not initialized");
  return _ctx;
}

/**
 * Allow tests to inject a fully-formed context without going through
 * Postgres / RPC / Pub/Sub. Production code should call `initContext()`.
 */
export function setContext(ctx: AppContext): void {
  _ctx = ctx;
}

export async function initContext(): Promise<AppContext> {
  const pg = new Pool({ connectionString: env.PG_URL });

  const registry = new EndpointRegistry(pg);
  const demoAllowlist = new Allowlist(pg, "demo_allowlist");
  const operatorAllowlist = new Allowlist(pg, "operator_allowlist");

  const balanceCheck = createBalanceCheck({
    rpcUrl: env.RPC_URL,
    usdcMint: env.USDC_MINT,
  });

  const sink = createPubSubSink(env.PUBSUB_PROJECT, env.PUBSUB_TOPIC);

  // 30s TTL by default. Env fallback uses `PACT_BETA_GATE_ENABLED` when
  // the Postgres lookup fails (see PRD "Feature flag" / Risks accepted).
  const betaGateFlag = createSystemFlagReader(pg);

  // Warm caches — don't throw on startup if DB unavailable yet.
  await Promise.allSettled([
    registry.reload(),
    demoAllowlist.reload(),
    operatorAllowlist.reload(),
  ]);

  _ctx = {
    registry,
    demoAllowlist,
    operatorAllowlist,
    balanceCheck,
    sink,
    pg,
    betaGateFlag,
  };
  return _ctx;
}
