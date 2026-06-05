import { Pool } from "pg";
import type { BalanceCheck, EventSink } from "@pact-network/wrap";
import {
  ChainAdapter,
  EvmAdapter,
  SolanaAdapter,
  getChain,
} from "@pact-network/shared";
import { resolveDeployment } from "@pact-network/protocol-evm-v1-client";
import { EndpointRegistry } from "./endpoints.js";
import { Allowlist } from "./allowlist.js";
import { createBalanceCheck } from "./balance.js";
import { createEventSink } from "./events.js";
import { createSystemFlagReader, type SystemFlagReader } from "./system-flag.js";
import { hasSolanaNetwork } from "./enabled-networks.js";
import { env } from "../env.js";

export function buildAdapterMap(processEnv: NodeJS.ProcessEnv): {
  adapters: Map<string, ChainAdapter>;
  legacyDirectSolana: boolean;
} {
  const adapters = new Map<string, ChainAdapter>();
  const legacyDirectSolana = processEnv.PACT_LEGACY_DIRECT_SOLANA === "true";

  const enabled = (processEnv.PACT_ENABLED_NETWORKS ?? "solana-devnet")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const name of enabled) {
    const descriptor = getChain(name); // throws on unknown
    if (descriptor.vm === "solana") {
      const envKey = `PACT_RPC_URL_${name.replace(/-/g, "_").toUpperCase()}`;
      const rpcUrl =
        processEnv[envKey] ??
        processEnv.SOLANA_RPC_URL ??
        "https://api.devnet.solana.com";
      adapters.set(name, new SolanaAdapter({ descriptor, rpcUrl }));
    } else if (descriptor.vm === "evm") {
      if (!descriptor.chainId) {
        throw new Error(`evm network ${name} missing chainId`);
      }
      if (!descriptor.rpcUrl) {
        throw new Error(`evm network ${name} missing rpcUrl`);
      }
      if (descriptor.finalityBlocks == null) {
        throw new Error(`evm network ${name} missing finalityBlocks`);
      }
      if (descriptor.blockTimeMs == null) {
        throw new Error(`evm network ${name} missing blockTimeMs`);
      }
      if (descriptor.deploymentBlock == null) {
        throw new Error(`evm network ${name} missing deploymentBlock`);
      }

      const deployment = resolveDeployment(
        descriptor.chainId,
        name,
        processEnv as Record<string, string | undefined>,
      );

      adapters.set(
        name,
        new EvmAdapter({
          descriptor,
          rpcUrl: descriptor.rpcUrl,
          finalityBlocks: descriptor.finalityBlocks,
          blockTimeMs: descriptor.blockTimeMs,
          deploymentBlock: BigInt(descriptor.deploymentBlock),
          deployment,
          // no signer — market-proxy is read-only
        }),
      );
    }
  }

  return { adapters, legacyDirectSolana };
}

export interface AppContext {
  registry: EndpointRegistry;
  demoAllowlist: Allowlist;
  operatorAllowlist: Allowlist;
  balanceCheck: BalanceCheck;
  sink: EventSink;
  pg: Pool;
  betaGateFlag: SystemFlagReader;
  adapters: Map<string, ChainAdapter>;
  legacyDirectSolana: boolean;
}

let _ctx: AppContext | null = null;

export function getContext(): AppContext {
  if (!_ctx) throw new Error("AppContext not initialized");
  return _ctx;
}

/**
 * Allow tests to inject a fully-formed context without going through
 * Postgres / RPC / Pub/Sub. Production code should call `initContext()`.
 */
export function setContext(ctx: AppContext): void {
  _ctx = ctx;
}

/**
 * Placeholder BalanceCheck for an EVM-only proxy boot (agent-tasks#14). The
 * Solana legacy-direct balance check is never selected on an EVM-only deploy
 * (proxy.ts only picks it for solana-* endpoints under legacyDirectSolana, and
 * an EVM-only proxy has no solana-* network). If it is ever reached, fail loud
 * rather than silently mis-checking custody.
 */
function evmOnlyBalanceCheckStub(): BalanceCheck {
  return {
    check() {
      throw new Error(
        "[market-proxy] Solana balance check unavailable on an EVM-only boot (no solana-* network enabled)",
      );
    },
  };
}

export async function initContext(): Promise<AppContext> {
  const pg = new Pool({ connectionString: env.PG_URL });

  const registry = new EndpointRegistry(pg);
  const demoAllowlist = new Allowlist(pg, "demo_allowlist");
  const operatorAllowlist = new Allowlist(pg, "operator_allowlist");

  // Solana balance check is the legacy-direct path (proxy.ts selects it only
  // when legacyDirectSolana && endpointNetwork starts with "solana-"). Build it
  // ONLY when a solana-* network is enabled (agent-tasks#14) so a base-only
  // proxy boots without SOLANA RPC_URL / USDC_MINT. EVM networks use their
  // adapter-backed balance check (adapterToBalanceCheck) selected per request.
  // The env schema guarantees RPC_URL / USDC_MINT are present whenever this
  // branch runs.
  const balanceCheck: BalanceCheck = hasSolanaNetwork(
    process.env.PACT_ENABLED_NETWORKS,
  )
    ? createBalanceCheck({
        rpcUrl: env.RPC_URL as string,
        usdcMint: env.USDC_MINT as string,
      })
    : evmOnlyBalanceCheckStub();

  const sink = createEventSink({
    backend: env.QUEUE_BACKEND,
    pubsubProject: env.PUBSUB_PROJECT,
    pubsubTopic: env.PUBSUB_TOPIC,
    redisUrl: env.REDIS_URL,
    redisStream: env.REDIS_STREAM,
  });

  // 30s TTL by default. Env fallback uses `PACT_BETA_GATE_ENABLED` when
  // the Postgres lookup fails (see PRD "Feature flag" / Risks accepted).
  const betaGateFlag = createSystemFlagReader(pg);

  const { adapters, legacyDirectSolana } = buildAdapterMap(process.env);

  // Warm caches — don't throw on startup if DB unavailable yet.
  await Promise.allSettled([
    registry.reload(),
    demoAllowlist.reload(),
    operatorAllowlist.reload(),
  ]);

  _ctx = {
    registry,
    demoAllowlist,
    operatorAllowlist,
    balanceCheck,
    sink,
    pg,
    betaGateFlag,
    adapters,
    legacyDirectSolana,
  };
  return _ctx;
}
