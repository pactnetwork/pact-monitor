import { z } from 'zod';
import { isAddress } from 'viem';

// Env booleans: only the literals "1"/"true" (case-insensitive) are true.
// `z.coerce.boolean()` is unusable here — it maps any non-empty string
// (including "0" and "false") to `true`.
const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true)$/i.test(v)));

const addr = z
  .string()
  .refine((v) => isAddress(v), { message: 'not a valid EVM address' });

const Env = z.object({
  // --- 0G Chain (read-only: pricing + balance reads) ---
  ZEROG_RPC_URL: z.string().url(),
  ZEROG_CHAIN_ID: z.coerce.number().int().positive(),
  PACT_CORE_ADDRESS: addr,
  // Premium token address. On Galileo testnet this is MockUsdc; on Aristotle
  // mainnet (16661) this is XSwap Bridged USDC.e
  // (0x1f3aA82227281Ca364bfb3D253b0F1af1da6473e).
  USDC_ADDRESS: addr,

  // --- 0G Compute broker wallet (SEPARATE key from settler's authority) ---
  ZEROG_COMPUTE_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x 32-byte hex private key'),
  // Informational only — the SDK auto-detects the ledger CA from chain id.
  ZEROG_COMPUTE_LEDGER_CONTRACT: z.string().optional(),
  ZEROG_COMPUTE_MIN_DEPOSIT_0G: z.coerce.number().positive().default(3),
  ZEROG_COMPUTE_SUBACCOUNT_FUND_0G: z.coerce.number().positive().default(2),
  ZEROG_COMPUTE_ENSURE_LEDGER: boolFromEnv(true),
  ZEROG_COMPUTE_TEE_VERIFY: boolFromEnv(false),

  // --- Pub/Sub (settler-evm consumes this topic) ---
  PUBSUB_PROJECT: z.string().min(1),
  PUBSUB_TOPIC: z.string().min(1),

  // --- Demo / ops ---
  // "1" enables the unauthenticated ?pact_wallet= path (off by default).
  PACT_PROXY_INSECURE_DEMO: z.string().default('0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(['error', 'warn', 'log', 'debug', 'verbose'])
    .default('log'),
});

export type EnvType = z.infer<typeof Env>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): EnvType {
  const result = Env.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid market-proxy-zerog env:\n${result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}
