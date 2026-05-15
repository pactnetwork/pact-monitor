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
  // NOTE: no QUEUE_BACKEND, REDIS_URL, REDIS_STREAM
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
    USDC_MINT: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
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
