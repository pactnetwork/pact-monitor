import { z } from 'zod';
import { isAddress } from 'viem';

/**
 * Pact-0G indexer env contract. The indexer reads `PactCore` logs from chain
 * directly (no settler push, no ingest endpoint, no push secret). It also
 * reads per-call evidence blobs from 0G Storage to recover `latencyMs`.
 *
 * No defaults for chain id / RPC / contract address — fail loud (master plan
 * "Env var management"). Single `ZEROG_RPC_URL` only (avoid cross-node head
 * races; 0G is BFT-final so one node is sufficient).
 */
const envSchema = z.object({
  PG_URL_ZEROG: z.string().min(1),
  ZEROG_RPC_URL: z.string().url(),
  ZEROG_CHAIN_ID: z.coerce.number().int().positive(),
  PACT_CORE_ADDRESS: z
    .string()
    .refine((v) => isAddress(v), { message: 'not a valid EVM address' }),
  ZEROG_STORAGE_INDEXER_URL: z.string().url(),
  /** First block to scan on a fresh cursor (the PactCore deploy block). */
  INDEXER_START_BLOCK: z.coerce.number().int().nonnegative(),
  /** Tail poll cadence; 0G blocks are ~1-2s. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /** getLogs page size; conservative — 0G public RPC limits undocumented. */
  LOG_RANGE: z.coerce.number().int().positive().default(500),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  PORT: z.coerce.number().default(3001),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid env: ${result.error.message}`);
  }
  return result.data;
}
