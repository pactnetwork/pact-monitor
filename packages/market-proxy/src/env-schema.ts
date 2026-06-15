// Pure env schema + parser. No module-level side effects so tests can
// import parseEnv without triggering an eager parse against process.env.
//
// Production code imports the live `env` binding from ./env (which does
// invoke parseEnv() once at module load). Tests import parseEnv from here
// and feed it a synthetic record.

import { z } from "zod";
import { hasSolanaNetwork } from "./lib/enabled-networks.js";

// Queue backend selector. Default "pubsub" preserves mainnet's byte-identical
// behavior when QUEUE_BACKEND is unset on production Cloud Run env. Devnet
// (Railway) sets this to "redis-streams".
const QueueBackend = z.enum(["pubsub", "redis-streams"]).default("pubsub");

export const Env = z
  .object({
    PG_URL: z.string().url(),
    // Solana-only config (RPC_URL / PROGRAM_ID / USDC_MINT). Optional at the
    // field level and enforced in the superRefine below ONLY when a solana-*
    // network is enabled (agent-tasks#14). This lets a base-only proxy
    // (PACT_ENABLED_NETWORKS=base-mainnet, no Solana env) parse without throwing,
    // while a Solana-enabled or unset (defaults to solana-devnet) config still
    // requires all three exactly as before. NB: PROGRAM_ID has no code consumer
    // in the proxy — it is validated for operator-config parity only.
    RPC_URL: z.string().url().optional(),
    PROGRAM_ID: z.string().min(32).optional(),
    USDC_MINT: z.string().min(32).optional(),
    // Multi-network selector. Drives the Solana-conditional requireds above and
    // mirrors the gating used by buildAdapterMap / the indexer. Unset defaults
    // to solana-devnet (see lib/enabled-networks.ts).
    PACT_ENABLED_NETWORKS: z.string().optional(),
    // QUEUE_BACKEND is optional; default "pubsub" so existing mainnet ENV_PROD
    // (which has no QUEUE_BACKEND key) parses unchanged.
    QUEUE_BACKEND: QueueBackend,
    // Pub/Sub fields: required only when backend = "pubsub" (enforced by the
    // superRefine below). Kept as plain strings so the "redis-streams" branch
    // can leave them unset without a Zod failure.
    PUBSUB_PROJECT: z.string().optional(),
    PUBSUB_TOPIC: z.string().optional(),
    // Redis Streams fields: required only when backend = "redis-streams".
    REDIS_URL: z.string().optional(),
    REDIS_STREAM: z.string().optional(),
    ENDPOINTS_RELOAD_TOKEN: z.string().min(16),
    PORT: z.string().default("8080"),
    // Private-beta-gate feature flag fallback (added by PR #198).
    // Consulted by `lib/system-flag.ts` when the `system_flags` row read
    // fails. Default "false" (off) matches the PRD "Feature flag" section.
    PACT_BETA_GATE_ENABLED: z.string().default("false"),
  })
  .superRefine((val, ctx) => {
    // Solana-conditional requireds (agent-tasks#14). When a solana-* network is
    // enabled (or PACT_ENABLED_NETWORKS is unset → defaults to solana-devnet),
    // RPC_URL / PROGRAM_ID / USDC_MINT are mandatory exactly as before. A
    // base-only proxy (no solana-* enabled) may omit all three.
    if (hasSolanaNetwork(val.PACT_ENABLED_NETWORKS)) {
      if (!val.RPC_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RPC_URL"],
          message:
            "RPC_URL is required when a solana-* network is enabled (or PACT_ENABLED_NETWORKS is unset)",
        });
      }
      if (!val.PROGRAM_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PROGRAM_ID"],
          message:
            "PROGRAM_ID is required when a solana-* network is enabled (or PACT_ENABLED_NETWORKS is unset)",
        });
      }
      if (!val.USDC_MINT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["USDC_MINT"],
          message:
            "USDC_MINT is required when a solana-* network is enabled (or PACT_ENABLED_NETWORKS is unset)",
        });
      }
    }

    if (val.QUEUE_BACKEND === "pubsub") {
      if (!val.PUBSUB_PROJECT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBSUB_PROJECT"],
          message: "PUBSUB_PROJECT is required when QUEUE_BACKEND is 'pubsub' (or unset)",
        });
      }
      if (!val.PUBSUB_TOPIC) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBSUB_TOPIC"],
          message: "PUBSUB_TOPIC is required when QUEUE_BACKEND is 'pubsub' (or unset)",
        });
      }
    } else if (val.QUEUE_BACKEND === "redis-streams") {
      if (!val.REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["REDIS_URL"],
          message: "REDIS_URL is required when QUEUE_BACKEND is 'redis-streams'",
        });
      }
      if (!val.REDIS_STREAM) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["REDIS_STREAM"],
          message: "REDIS_STREAM is required when QUEUE_BACKEND is 'redis-streams'",
        });
      }
    }
  });

export type EnvType = z.infer<typeof Env>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): EnvType {
  return Env.parse(raw);
}
