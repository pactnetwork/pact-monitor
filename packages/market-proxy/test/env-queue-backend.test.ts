// Env schema — QUEUE_BACKEND conditional refinement.
//
// Mainnet safety invariant (plan §10.3): parsing the verbatim mainnet
// ENV_PROD shape (with no QUEUE_BACKEND key) must succeed and yield
// QUEUE_BACKEND="pubsub". The original required PUBSUB_* fields stay
// required; new optional REDIS_* fields are only validated when
// QUEUE_BACKEND="redis-streams".

import { describe, test, expect } from "vitest";
import { parseEnv } from "../src/env-schema";

// Frozen mainnet env snapshot. Same keys as production ENV_PROD; values
// are placeholders but the *shape* is verbatim — adding/removing any key
// here must be a deliberate decision tied to a mainnet env change.
const mainnetEnvSnapshot: Record<string, string> = {
  PG_URL: "postgresql://user:pass@host:5432/db",
  RPC_URL: "https://api.mainnet-beta.solana.com",
  PROGRAM_ID: "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  PUBSUB_PROJECT: "pact-network",
  PUBSUB_TOPIC: "pact-settle-events",
  ENDPOINTS_RELOAD_TOKEN: "0123456789abcdef0123456789abcdef",
  PORT: "8080",
  // NOTE: deliberately no QUEUE_BACKEND, REDIS_URL, REDIS_STREAM
};

describe("env schema — QUEUE_BACKEND defaulting (mainnet invariant)", () => {
  test("mainnet env snapshot parses with QUEUE_BACKEND defaulted to 'pubsub'", () => {
    const parsed = parseEnv(mainnetEnvSnapshot);
    expect(parsed.QUEUE_BACKEND).toBe("pubsub");
    expect(parsed.PUBSUB_PROJECT).toBe("pact-network");
    expect(parsed.PUBSUB_TOPIC).toBe("pact-settle-events");
    expect(parsed.REDIS_URL).toBeUndefined();
    expect(parsed.REDIS_STREAM).toBeUndefined();
  });

  test("explicit QUEUE_BACKEND=pubsub behaves identically to unset", () => {
    const parsed = parseEnv({ ...mainnetEnvSnapshot, QUEUE_BACKEND: "pubsub" });
    expect(parsed.QUEUE_BACKEND).toBe("pubsub");
    expect(parsed.PUBSUB_PROJECT).toBe("pact-network");
  });

  test("pubsub backend rejects missing PUBSUB_PROJECT", () => {
    const env = { ...mainnetEnvSnapshot };
    delete env.PUBSUB_PROJECT;
    expect(() => parseEnv(env)).toThrow(/PUBSUB_PROJECT/);
  });

  test("pubsub backend rejects missing PUBSUB_TOPIC", () => {
    const env = { ...mainnetEnvSnapshot };
    delete env.PUBSUB_TOPIC;
    expect(() => parseEnv(env)).toThrow(/PUBSUB_TOPIC/);
  });
});

describe("env schema — redis-streams backend", () => {
  const devnetEnvSnapshot: Record<string, string> = {
    PG_URL: "postgresql://user:pass@host:5432/db",
    RPC_URL: "https://api.devnet.solana.com",
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    QUEUE_BACKEND: "redis-streams",
    REDIS_URL: "redis://default:secret@redis.railway.internal:6379",
    REDIS_STREAM: "pact-settle-events",
    ENDPOINTS_RELOAD_TOKEN: "0123456789abcdef0123456789abcdef",
    PORT: "8080",
  };

  test("devnet env snapshot parses without PUBSUB_* keys", () => {
    const parsed = parseEnv(devnetEnvSnapshot);
    expect(parsed.QUEUE_BACKEND).toBe("redis-streams");
    expect(parsed.REDIS_URL).toBe(devnetEnvSnapshot.REDIS_URL);
    expect(parsed.REDIS_STREAM).toBe("pact-settle-events");
    expect(parsed.PUBSUB_PROJECT).toBeUndefined();
    expect(parsed.PUBSUB_TOPIC).toBeUndefined();
  });

  test("redis-streams backend rejects missing REDIS_URL", () => {
    const env = { ...devnetEnvSnapshot };
    delete env.REDIS_URL;
    expect(() => parseEnv(env)).toThrow(/REDIS_URL/);
  });

  test("redis-streams backend rejects missing REDIS_STREAM", () => {
    const env = { ...devnetEnvSnapshot };
    delete env.REDIS_STREAM;
    expect(() => parseEnv(env)).toThrow(/REDIS_STREAM/);
  });

  test("unknown QUEUE_BACKEND value is rejected by enum", () => {
    expect(() =>
      parseEnv({ ...devnetEnvSnapshot, QUEUE_BACKEND: "kafka" }),
    ).toThrow();
  });
});
