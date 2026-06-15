// Pure env schema + parser for the indexer. No module-level side effects so
// tests can import parseEnv without triggering an eager parse against
// process.env.
//
// NOTE: this schema is the documented env contract and the spec fixture only —
// it is NOT wired into ConfigModule.forRoot (no validate callback) and does NOT
// gate boot. Wiring validation into boot is a separate follow-up (avoids
// behavior change risk for prod; same pattern as packages/settler/src/config/env.ts).
//
// Variables enumerated by grepping config.get / process.env across
// packages/indexer/src (agent-tasks#12).

import { z } from "zod";
import { hasSolanaNetwork } from "./lib/enabled-networks";

export const IndexerEnv = z
  .object({
    // -----------------------------------------------------------------------
    // Database
    // -----------------------------------------------------------------------
    // PG_URL is the connection string consumed by the @pact-network/db Prisma
    // schema (packages/db/prisma/schema.prisma: url = env("PG_URL")).
    PG_URL: z.string().url(),

    // -----------------------------------------------------------------------
    // Multi-network selector
    // -----------------------------------------------------------------------
    // Drives the Solana-conditional requireds below and mirrors the gating
    // used by AdaptersService / OnChainSyncService. Unset defaults to
    // "solana-devnet" (see lib/enabled-networks.ts).
    PACT_ENABLED_NETWORKS: z.string().optional(),

    // -----------------------------------------------------------------------
    // Solana-only config (conditional — see superRefine below)
    // -----------------------------------------------------------------------
    // SOLANA_RPC_URL: consumed by AdaptersService.resolveRpcUrl and
    //   OnChainSyncService (both fall back to DEFAULT_RPC_URL when unset).
    //   Required here when solana-* is enabled so the operator contract is
    //   explicit; the runtime fallback to mainnet-beta is a footgun.
    SOLANA_RPC_URL: z.string().url().optional(),
    // PROGRAM_ID: consumed by OnChainSyncService (falls back to
    //   DEFAULT_PROGRAM_ID = PROGRAM_ID from @q3labs/pact-protocol-v1-client).
    PROGRAM_ID: z.string().min(32).optional(),

    // -----------------------------------------------------------------------
    // EVM per-network RPC override (optional, dynamic key not enumerable here)
    // -----------------------------------------------------------------------
    // PACT_RPC_URL_{NETWORK_UPPER}: per-network RPC URL override resolved by
    //   AdaptersService.resolveRpcUrl (e.g. PACT_RPC_URL_BASE_MAINNET).
    //   Not enumerable in the schema (the key is derived at runtime from the
    //   enabled network list); operators set it alongside PACT_ENABLED_NETWORKS.

    // -----------------------------------------------------------------------
    // Ingest auth
    // -----------------------------------------------------------------------
    INDEXER_PUSH_SECRET: z.string().min(1),

    // -----------------------------------------------------------------------
    // Helius webhook (optional — only on deployments that enable account
    // change webhooks from Helius; consumed by webhook.controller.ts)
    // -----------------------------------------------------------------------
    HELIUS_WEBHOOK_SECRET: z.string().optional(),

    // -----------------------------------------------------------------------
    // Refund-delivery webhook (all optional — each has a safe runtime default)
    // -----------------------------------------------------------------------
    WEBHOOK_DELIVERY_ENABLED: z.enum(["true", "false"]).optional(),
    WEBHOOK_MAX_FAIL_COUNT: z.coerce.number().int().positive().optional(),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().optional(),
    WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().positive().optional(),
    WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().positive().optional(),
    INDEXER_WEBHOOK_SIGNING_SECRET: z.string().optional(),

    // -----------------------------------------------------------------------
    // Feature flags
    // -----------------------------------------------------------------------
    // PACT_LEGACY_DIRECT_SOLANA: if "true", AdaptersService bypasses the
    //   adapter abstraction and uses the legacy direct getProgramAccounts path
    //   for Solana. Off by default.
    PACT_LEGACY_DIRECT_SOLANA: z.enum(["true", "false"]).optional(),

    // -----------------------------------------------------------------------
    // Server
    // -----------------------------------------------------------------------
    PORT: z.coerce.number().default(3001),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["error", "warn", "log", "debug", "verbose"])
      .default("log"),
  })
  .superRefine((val, ctx) => {
    // Solana-conditional requireds (agent-tasks#12). When a solana-* network is
    // enabled (or PACT_ENABLED_NETWORKS is unset → defaults to solana-devnet),
    // SOLANA_RPC_URL and PROGRAM_ID are mandatory. An EVM-only indexer
    // (e.g. PACT_ENABLED_NETWORKS=base-mainnet) may omit both.
    //
    // The runtime fallback to DEFAULT_RPC_URL (mainnet-beta) and DEFAULT_PROGRAM_ID
    // in OnChainSyncService is a footgun: if a Solana-enabled deploy silently
    // omits SOLANA_RPC_URL it would point at mainnet-beta instead of the intended
    // network. Making these required at the schema level surfaces the misconfiguration
    // before boot rather than silently misbehaving.
    //
    // NOTE: the runtime does NOT enforce this today (no validate wired into boot).
    // This is the contract/spec layer only — enforcement is a follow-up.
    if (hasSolanaNetwork(val.PACT_ENABLED_NETWORKS)) {
      if (!val.SOLANA_RPC_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SOLANA_RPC_URL"],
          message:
            "SOLANA_RPC_URL is required when a solana-* network is enabled (or PACT_ENABLED_NETWORKS is unset)",
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
    }
  });

export type IndexerEnvType = z.infer<typeof IndexerEnv>;

export function parseEnv(
  raw: NodeJS.ProcessEnv = process.env,
): IndexerEnvType {
  return IndexerEnv.parse(raw);
}
