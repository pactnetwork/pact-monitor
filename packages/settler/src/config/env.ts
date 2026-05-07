import { z } from "zod";

/**
 * Settler env contract — see Step D #62 of the layering refactor:
 *   docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md
 *
 * Notable changes from the pre-Step-C settler:
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
 */
const envSchema = z.object({
  PUBSUB_PROJECT: z.string().min(1),
  PUBSUB_SUBSCRIPTION: z.string().min(1),
  SOLANA_RPC_URL: z.string().url(),
  SETTLEMENT_AUTHORITY_KEY: z.string().min(1),
  PROGRAM_ID: z.string().default("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5"),
  USDC_MINT: z.string().optional(),
  INDEXER_URL: z.string().url(),
  INDEXER_PUSH_SECRET: z.string().min(1),
  LOG_LEVEL: z.enum(["error", "warn", "log", "debug", "verbose"]).default("log"),
  PORT: z.coerce.number().default(8080),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid env: ${result.error.message}`);
  }
  return result.data;
}
