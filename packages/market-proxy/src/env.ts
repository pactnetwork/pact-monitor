import { z } from "zod";

const Env = z.object({
  PG_URL: z.string().url(),
  RPC_URL: z.string().url(),
  PROGRAM_ID: z.string().min(32),
  PUBSUB_PROJECT: z.string(),
  PUBSUB_TOPIC: z.string(),
  ENDPOINTS_RELOAD_TOKEN: z.string().min(16),
  PORT: z.string().default("8080"),
});

export type EnvType = z.infer<typeof Env>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): EnvType {
  return Env.parse(raw);
}

export const env = parseEnv();
