import { z } from "zod";

const envSchema = z.object({
  PUBSUB_PROJECT: z.string().min(1),
  PUBSUB_SUBSCRIPTION: z.string().min(1),
  SOLANA_RPC_URL: z.string().url(),
  SETTLEMENT_AUTHORITY_KEY: z.string().min(1),
  PROGRAM_ID: z.string().default("DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc"),
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
