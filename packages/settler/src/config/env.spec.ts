// Settler env schema — mainnet invariant + backend-specific validation.
//
// Mainnet safety property (plan/devnet-mirror-build §10.1):
//   Parsing the verbatim mainnet ENV_PROD (which has no QUEUE_BACKEND key)
//   must succeed, default QUEUE_BACKEND to "pubsub", and keep the original
//   PUBSUB_PROJECT + PUBSUB_SUBSCRIPTION required-ness intact.
//
// This is the golden-file guard. Any change that breaks this test breaks
// mainnet's next deploy — by design.

import { describe, it, expect } from "vitest";
import { parseEnv } from "./env";

// Frozen mainnet env snapshot. Keys are verbatim from the mainnet runtime
// (docs/mainnet-cloud-run-deploy.md + memory mainnet_offchain_stack.md).
// Values are placeholders for non-secrets; SETTLEMENT_AUTHORITY_KEY is a
// minimum-length stub.
// NOTE: no PACT_ENABLED_NETWORKS key — unset defaults to "solana-devnet" which
// means SOLANA_RPC_URL + SETTLEMENT_AUTHORITY_KEY remain required (byte-identical
// behavior to pre-agent-tasks#12).
const mainnetEnvSnapshot: Record<string, string> = {
  PUBSUB_PROJECT: "pact-network",
  PUBSUB_SUBSCRIPTION: "pact-settle-events-settler",
  SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=redacted",
  SETTLEMENT_AUTHORITY_KEY:
    "projects/224627201825/secrets/PACT_SETTLEMENT_AUTHORITY_BS58/versions/1",
  PROGRAM_ID: "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  INDEXER_URL: "https://indexer.pactnetwork.io",
  INDEXER_PUSH_SECRET: "0123456789abcdef0123456789abcdef",
  LOG_LEVEL: "log",
  PORT: "8080",
  // NOTE: no QUEUE_BACKEND, REDIS_URL, REDIS_STREAM, PACT_ENABLED_NETWORKS
};

describe("settler env schema — mainnet invariant", () => {
  it("parses verbatim mainnet ENV_PROD with QUEUE_BACKEND defaulted to 'pubsub'", () => {
    const env = parseEnv(mainnetEnvSnapshot);
    expect(env.QUEUE_BACKEND).toBe("pubsub");
    expect(env.PUBSUB_PROJECT).toBe("pact-network");
    expect(env.PUBSUB_SUBSCRIPTION).toBe("pact-settle-events-settler");
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.REDIS_STREAM).toBeUndefined();
  });

  it("explicit QUEUE_BACKEND=pubsub yields identical parse to unset", () => {
    const env = parseEnv({ ...mainnetEnvSnapshot, QUEUE_BACKEND: "pubsub" });
    expect(env.QUEUE_BACKEND).toBe("pubsub");
    expect(env.PUBSUB_PROJECT).toBe("pact-network");
  });

  it("rejects mainnet env if PUBSUB_PROJECT is missing", () => {
    const e = { ...mainnetEnvSnapshot };
    delete e.PUBSUB_PROJECT;
    expect(() => parseEnv(e)).toThrow(/PUBSUB_PROJECT/);
  });

  it("rejects mainnet env if PUBSUB_SUBSCRIPTION is missing", () => {
    const e = { ...mainnetEnvSnapshot };
    delete e.PUBSUB_SUBSCRIPTION;
    expect(() => parseEnv(e)).toThrow(/PUBSUB_SUBSCRIPTION/);
  });
});

describe("settler env schema — redis-streams backend (devnet)", () => {
  const devnetEnvSnapshot: Record<string, string> = {
    SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=redacted",
    SETTLEMENT_AUTHORITY_KEY: "0123456789abcdef".repeat(2),
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    INDEXER_URL: "https://indexer-devnet.pactnetwork.io",
    INDEXER_PUSH_SECRET: "0123456789abcdef0123456789abcdef",
    QUEUE_BACKEND: "redis-streams",
    REDIS_URL: "redis://default:secret@redis.railway.internal:6379",
    REDIS_STREAM: "pact-settle-events",
    LOG_LEVEL: "log",
    PORT: "8080",
  };

  it("parses devnet snapshot without PUBSUB_* keys", () => {
    const env = parseEnv(devnetEnvSnapshot);
    expect(env.QUEUE_BACKEND).toBe("redis-streams");
    expect(env.REDIS_URL).toBe(devnetEnvSnapshot.REDIS_URL);
    expect(env.REDIS_STREAM).toBe("pact-settle-events");
    expect(env.REDIS_CONSUMER_GROUP).toBe("settler"); // default
  });

  it("rejects redis-streams env if REDIS_URL is missing", () => {
    const e = { ...devnetEnvSnapshot };
    delete e.REDIS_URL;
    expect(() => parseEnv(e)).toThrow(/REDIS_URL/);
  });

  it("rejects redis-streams env if REDIS_STREAM is missing", () => {
    const e = { ...devnetEnvSnapshot };
    delete e.REDIS_STREAM;
    expect(() => parseEnv(e)).toThrow(/REDIS_STREAM/);
  });

  it("honors a custom REDIS_CONSUMER_GROUP override", () => {
    const env = parseEnv({
      ...devnetEnvSnapshot,
      REDIS_CONSUMER_GROUP: "settler-alt",
    });
    expect(env.REDIS_CONSUMER_GROUP).toBe("settler-alt");
  });
});

describe("settler env schema — memory backend (local dev)", () => {
  const memoryEnvSnapshot: Record<string, string> = {
    SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=redacted",
    SETTLEMENT_AUTHORITY_KEY: "0123456789abcdef".repeat(2),
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    INDEXER_URL: "http://localhost:8081",
    INDEXER_PUSH_SECRET: "0123456789abcdef0123456789abcdef",
    QUEUE_BACKEND: "memory",
    LOG_LEVEL: "log",
    PORT: "8080",
  };

  it("parses memory backend without PUBSUB_* or REDIS_* keys", () => {
    const env = parseEnv(memoryEnvSnapshot);
    expect(env.QUEUE_BACKEND).toBe("memory");
    expect(env.PUBSUB_PROJECT).toBeUndefined();
    expect(env.PUBSUB_SUBSCRIPTION).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.REDIS_STREAM).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agent-tasks#12 — Solana-conditional env contract (EVM-only support)
// ---------------------------------------------------------------------------
describe("settler env schema — Solana-conditional requireds (agent-tasks#12)", () => {
  // Minimal EVM-only env: PACT_ENABLED_NETWORKS has no solana-* slug, so
  // SOLANA_RPC_URL and SETTLEMENT_AUTHORITY_KEY are not required.
  const evmOnlyEnvSnapshot: Record<string, string> = {
    PACT_ENABLED_NETWORKS: "base-mainnet",
    INDEXER_URL: "https://indexer.pactnetwork.io",
    INDEXER_PUSH_SECRET: "0123456789abcdef0123456789abcdef",
    QUEUE_BACKEND: "memory",
    LOG_LEVEL: "log",
    PORT: "8080",
  };

  it("(a) mainnet snapshot unchanged: no PACT_ENABLED_NETWORKS key still requires Solana vars", () => {
    // Regression guard: mainnetEnvSnapshot has no PACT_ENABLED_NETWORKS →
    // defaults to solana-devnet → SOLANA_RPC_URL + SETTLEMENT_AUTHORITY_KEY
    // still required (byte-identical behavior to pre-agent-tasks#12).
    const env = parseEnv(mainnetEnvSnapshot);
    expect(env.SOLANA_RPC_URL).toBe("https://mainnet.helius-rpc.com/?api-key=redacted");
    expect(env.SETTLEMENT_AUTHORITY_KEY).toContain("224627201825");
    expect(env.PACT_ENABLED_NETWORKS).toBeUndefined();
  });

  it("(b) EVM-only env (PACT_ENABLED_NETWORKS=base-mainnet) parses without SOLANA_RPC_URL or SETTLEMENT_AUTHORITY_KEY", () => {
    const env = parseEnv(evmOnlyEnvSnapshot);
    expect(env.PACT_ENABLED_NETWORKS).toBe("base-mainnet");
    expect(env.SOLANA_RPC_URL).toBeUndefined();
    expect(env.SETTLEMENT_AUTHORITY_KEY).toBeUndefined();
    expect(env.QUEUE_BACKEND).toBe("memory");
  });

  it("(b) EVM-only env also parses with QUEUE_BACKEND=redis-streams", () => {
    const env = parseEnv({
      ...evmOnlyEnvSnapshot,
      QUEUE_BACKEND: "redis-streams",
      REDIS_URL: "redis://default:secret@redis.railway.internal:6379",
      REDIS_STREAM: "pact-settle-events",
    });
    expect(env.PACT_ENABLED_NETWORKS).toBe("base-mainnet");
    expect(env.SOLANA_RPC_URL).toBeUndefined();
    expect(env.SETTLEMENT_AUTHORITY_KEY).toBeUndefined();
    expect(env.QUEUE_BACKEND).toBe("redis-streams");
  });

  it("(c) solana-enabled env without SOLANA_RPC_URL throws", () => {
    const e: Record<string, string> = {
      ...mainnetEnvSnapshot,
      PACT_ENABLED_NETWORKS: "solana-devnet",
    };
    delete e.SOLANA_RPC_URL;
    expect(() => parseEnv(e)).toThrow(/SOLANA_RPC_URL/);
  });

  it("(c) solana-enabled env without SETTLEMENT_AUTHORITY_KEY throws", () => {
    const e: Record<string, string> = {
      ...mainnetEnvSnapshot,
      PACT_ENABLED_NETWORKS: "solana-devnet",
    };
    delete e.SETTLEMENT_AUTHORITY_KEY;
    expect(() => parseEnv(e)).toThrow(/SETTLEMENT_AUTHORITY_KEY/);
  });

  it("mixed solana+evm env still requires Solana vars when solana-* is in the list", () => {
    const e: Record<string, string> = {
      ...mainnetEnvSnapshot,
      PACT_ENABLED_NETWORKS: "base-mainnet,solana-mainnet",
    };
    delete e.SOLANA_RPC_URL;
    expect(() => parseEnv(e)).toThrow(/SOLANA_RPC_URL/);
  });

  it("PACT_ENABLED_NETWORKS is captured on the returned Env type when present", () => {
    const env = parseEnv(evmOnlyEnvSnapshot);
    expect(env.PACT_ENABLED_NETWORKS).toBe("base-mainnet");
  });
});
