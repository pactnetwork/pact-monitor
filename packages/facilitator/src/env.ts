import { z } from "zod";

// Facilitator service env. Mirrors packages/market-proxy/src/env.ts where the
// keys overlap (PG_URL / RPC_URL / PROGRAM_ID / USDC_MINT / PUBSUB_*) so a
// shared deploy config works for both. `PUBSUB_TOPIC` MUST be the SAME topic
// the market-proxy publishes to — the existing settler consumes that topic and
// drives `settle_batch` for both gateway calls and pay.sh-covered calls.
const Env = z.object({
  // Shared Postgres (the indexer's DB). Used by GET /v1/coverage/:id.
  PG_URL: z.string().url(),
  // Solana JSON-RPC. Used to verify the agent's payment tx + read the agent's
  // USDC ATA balance/allowance.
  RPC_URL: z.string().url(),
  // V1 program id (for ATA derivation parity; not strictly required today but
  // kept for consistency with the other services + future PDA reads).
  PROGRAM_ID: z.string().min(32),
  // USDC mint for this network (mainnet/devnet differ).
  USDC_MINT: z.string().min(32),
  // GCP project + the SHARED settlement Pub/Sub topic (same as market-proxy's).
  PUBSUB_PROJECT: z.string(),
  PUBSUB_TOPIC: z.string(),
  // Synthetic coverage-pool slug for pay.sh-covered calls (MVP: one shared
  // launch pool). Must be <=16 chars (matches the on-chain 16-byte slug and
  // the Endpoint.slug VARCHAR(16) column).
  PAY_DEFAULT_SLUG: z.string().max(16).default("pay-default"),
  // Flat premium charged per pay.sh-covered call, in USDC base units. Falls
  // back to the seeded `pay-default` Endpoint row's flatPremiumLamports if the
  // DB lookup succeeds; this is the bootstrap value used before the row exists.
  PAY_DEFAULT_FLAT_PREMIUM_LAMPORTS: z
    .string()
    .regex(/^\d+$/)
    .default("1000"),
  // Per-call refund ceiling on a covered breach, in USDC base units. The
  // refund equals what the agent actually paid the merchant, capped at this
  // value so a single large claim can't drain the subsidised launch pool.
  // Default 1_000_000 ($1.00) — covers typical small x402 payments in full.
  // Same fallback rule as the premium (the seeded `pay-default` Endpoint row's
  // imputedCostLamports wins once it exists).
  PAY_DEFAULT_IMPUTED_COST_LAMPORTS: z
    .string()
    .regex(/^\d+$/)
    .default("1000000"),
  // SLA latency (ms) the facilitator advertises for pay.sh-covered calls. The
  // verdict the CLI sends is authoritative for the outcome; this is metadata.
  PAY_DEFAULT_SLA_LATENCY_MS: z
    .string()
    .regex(/^\d+$/)
    .default("10000"),
  // Hourly exposure cap (USDC base units) the facilitator advertises for the
  // pay-default pool. Enforced on-chain by `settle_batch`. Default 5_000_000
  // ($5.00/rolling hour) — deliberately tight for the subsidised launch float.
  PAY_DEFAULT_EXPOSURE_CAP_PER_HOUR_LAMPORTS: z
    .string()
    .regex(/^\d+$/)
    .default("5000000"),
  PORT: z.string().default("8080"),
});

export type EnvType = z.infer<typeof Env>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): EnvType {
  return Env.parse(raw);
}

export const env = parseEnv();
