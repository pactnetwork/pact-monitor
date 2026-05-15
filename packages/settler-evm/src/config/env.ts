import { z } from 'zod';
import { isAddress } from 'viem';

/**
 * Pact-0G settler env contract. EVM port of `@pact-network/settler`'s schema.
 *
 * Divergences from the Solana settler:
 *   - SOLANA_RPC_URL / PROGRAM_ID / USDC_MINT → ZEROG_RPC_URL / ZEROG_CHAIN_ID
 *     / PACT_CORE_ADDRESS. No defaults for chain id / RPC / contract address —
 *     fail loudly (master plan "Env var management").
 *   - INDEXER_URL / INDEXER_PUSH_SECRET removed: `indexer-evm` reads
 *     `CallSettled`/`RecipientPaid` logs from chain directly, the settler does
 *     not push.
 *   - PG_URL_ZEROG added: the orphan-blob tracker (`FailedSettlement`) is a
 *     direct Postgres write via `@pact-network/db-zerog`.
 *   - ZEROG_STORAGE_INDEXER_URL added: per-call evidence upload target.
 *   - SETTLEMENT_AUTHORITY_KEY is now a 0x EVM private key (or a Secret
 *     Manager resource path resolving to one) — see SecretLoaderService.
 *   - MAX_BATCH_SIZE env-tunable, hard-capped at the contract's cap (50).
 */
const envSchema = z.object({
  PUBSUB_PROJECT: z.string().min(1),
  PUBSUB_SUBSCRIPTION: z.string().min(1),
  ZEROG_RPC_URL: z.string().url(),
  ZEROG_CHAIN_ID: z.coerce.number().int().positive(),
  PACT_CORE_ADDRESS: z
    .string()
    .refine((v) => isAddress(v), { message: 'not a valid EVM address' }),
  ZEROG_STORAGE_INDEXER_URL: z.string().url(),
  SETTLEMENT_AUTHORITY_KEY: z.string().min(1),
  PG_URL_ZEROG: z.string().min(1),
  MAX_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
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
