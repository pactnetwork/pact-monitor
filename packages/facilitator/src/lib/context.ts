// App context — wiring for routes. Mirrors packages/market-proxy/src/lib/context.ts.

import { Pool } from "pg";
import { Connection } from "@solana/web3.js";
import type { BalanceCheck } from "@pact-network/wrap";
import { createAllowanceCheck } from "./allowance.js";
import { createPubSubPublisher, type EventPublisher } from "./events.js";
import { env } from "../env.js";

export interface PayDefaults {
  slug: string;
  flatPremiumLamports: bigint;
  imputedCostLamports: bigint;
  slaLatencyMs: number;
  exposureCapPerHourLamports: bigint;
}

export interface AppContext {
  pg: Pool;
  connection: Connection;
  allowanceCheck: BalanceCheck;
  publisher: EventPublisher;
  usdcMint: string;
  payDefaults: PayDefaults;
}

let _ctx: AppContext | null = null;

export function getContext(): AppContext {
  if (!_ctx) throw new Error("AppContext not initialized");
  return _ctx;
}

/** Inject a fully-formed context (tests). */
export function setContext(ctx: AppContext): void {
  _ctx = ctx;
}

export function resetContext(): void {
  _ctx = null;
}

export function payDefaultsFromEnv(): PayDefaults {
  return {
    slug: env.PAY_DEFAULT_SLUG,
    flatPremiumLamports: BigInt(env.PAY_DEFAULT_FLAT_PREMIUM_LAMPORTS),
    imputedCostLamports: BigInt(env.PAY_DEFAULT_IMPUTED_COST_LAMPORTS),
    slaLatencyMs: Number(env.PAY_DEFAULT_SLA_LATENCY_MS),
    exposureCapPerHourLamports: BigInt(env.PAY_DEFAULT_EXPOSURE_CAP_PER_HOUR_LAMPORTS),
  };
}

export function initContext(): AppContext {
  const pg = new Pool({ connectionString: env.PG_URL });
  const connection = new Connection(env.RPC_URL, "confirmed");
  const allowanceCheck = createAllowanceCheck({
    rpcUrl: env.RPC_URL,
    usdcMint: env.USDC_MINT,
  });
  const publisher = createPubSubPublisher(env.PUBSUB_PROJECT, env.PUBSUB_TOPIC);

  _ctx = {
    pg,
    connection,
    allowanceCheck,
    publisher,
    usdcMint: env.USDC_MINT,
    payDefaults: payDefaultsFromEnv(),
  };
  return _ctx;
}
