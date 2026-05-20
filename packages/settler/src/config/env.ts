import { z } from "zod";

/**
 * Settler env contract — see Step D #62 of the layering refactor:
 *   docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md
 * Backend selection (QUEUE_BACKEND) added per plan/devnet-mirror-build §4.4.
 *
 * Notable points:
 *   - POOL_VAULT_PUBKEY removed: per-endpoint coverage pools mean each event
 *     resolves its own pool from the slug, so a global pool vault env is no
 *     longer meaningful.
 *   - PROGRAM_ID default updated to the post-Step-C devnet redeploy
 *     `5jBQb7fL...` (the pre-refactor `DhWibM...` is orphaned and MUST NOT be
 *     contacted by new settler instances).
 *   - Treasury PDA + vault are derived at boot from the program ID, no env
 *     var needed.
 *   - SETTLEMENT_AUTHORITY_KEY accepts either a Secret Manager resource path
 *     ("projects/<proj>/secrets/<name>/versions/<n>") OR a raw base58 secret
 *     key. Same as the pre-existing SecretLoaderService contract.
 *   - USDC_MINT (optional) overrides the devnet default for mainnet runs.
 *   - QUEUE_BACKEND: "pubsub" (default — mainnet) | "redis-streams" (devnet
 *     on Railway). Each backend has its own required-field set enforced via
 *     superRefine so mainnet ENV_PROD (which has no QUEUE_BACKEND key)
 *     parses unchanged with the existing PUBSUB_* fields required.
 */
const envSchema = z
  .object({
    SOLANA_RPC_URL: z.string().url(),
    SETTLEMENT_AUTHORITY_KEY: z.string().min(1),
    PROGRAM_ID: z.string().default("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"),
    USDC_MINT: z.string().optional(),
    INDEXER_URL: z.string().url(),
    INDEXER_PUSH_SECRET: z.string().min(1),
    LOG_LEVEL: z.enum(["error", "warn", "log", "debug", "verbose"]).default("log"),
    PORT: z.coerce.number().default(8080),

    // Queue backend selector. Default "pubsub" preserves mainnet behavior
    // byte-for-byte when QUEUE_BACKEND is unset in ENV_PROD.
    QUEUE_BACKEND: z.enum(["pubsub", "redis-streams"]).default("pubsub"),

    // Pub/Sub fields — required only when QUEUE_BACKEND is "pubsub" or
    // unset. Made optional at the type layer; the superRefine below
    // enforces required-ness based on backend.
    PUBSUB_PROJECT: z.string().optional(),
    PUBSUB_SUBSCRIPTION: z.string().optional(),

    // Redis Streams fields — required only when QUEUE_BACKEND is
    // "redis-streams". REDIS_CONSUMER_GROUP defaults to "settler".
    REDIS_URL: z.string().optional(),
    REDIS_STREAM: z.string().optional(),
    REDIS_CONSUMER_GROUP: z.string().default("settler"),
  })
  .superRefine((val, ctx) => {
    if (val.QUEUE_BACKEND === "pubsub") {
      if (!val.PUBSUB_PROJECT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBSUB_PROJECT"],
          message:
            "PUBSUB_PROJECT is required when QUEUE_BACKEND is 'pubsub' (or unset)",
        });
      }
      if (!val.PUBSUB_SUBSCRIPTION) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBSUB_SUBSCRIPTION"],
          message:
            "PUBSUB_SUBSCRIPTION is required when QUEUE_BACKEND is 'pubsub' (or unset)",
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

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid env: ${result.error.message}`);
  }
  return result.data;
}
