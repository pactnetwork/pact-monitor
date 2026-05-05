import { Pool } from "pg";
import { EndpointRegistry } from "./endpoints.js";
import { Allowlist } from "./allowlist.js";
import { BalanceCache, type RpcClient } from "./balance.js";
import { createPubSubPublisher, type EventPublisher } from "./events.js";
import { env } from "../env.js";

export interface AppContext {
  registry: EndpointRegistry;
  demoAllowlist: Allowlist;
  operatorAllowlist: Allowlist;
  balanceCache: BalanceCache;
  publisher: EventPublisher;
  pg: Pool;
}

let _ctx: AppContext | null = null;

export function getContext(): AppContext {
  if (!_ctx) throw new Error("AppContext not initialized");
  return _ctx;
}

export async function initContext(): Promise<AppContext> {
  const pg = new Pool({ connectionString: env.PG_URL });

  const rpc: RpcClient = {
    async getAccountInfo(pubkey: string) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [pubkey, { encoding: "base64" }],
      });
      const resp = await fetch(env.RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await resp.json() as { result?: { value?: { data: string[] } } };
      const data = json.result?.value?.data?.[0];
      if (!data) return null;
      return { data: Buffer.from(data, "base64") };
    },
  };

  const registry = new EndpointRegistry(pg);
  const demoAllowlist = new Allowlist(pg, "demo_allowlist");
  const operatorAllowlist = new Allowlist(pg, "operator_allowlist");
  const balanceCache = new BalanceCache(rpc);
  const publisher = createPubSubPublisher(env.PUBSUB_PROJECT, env.PUBSUB_TOPIC);

  // Warm caches — don't throw on startup if DB unavailable yet
  await Promise.allSettled([
    registry.reload(),
    demoAllowlist.reload(),
    operatorAllowlist.reload(),
  ]);

  _ctx = { registry, demoAllowlist, operatorAllowlist, balanceCache, publisher, pg };
  return _ctx;
}
