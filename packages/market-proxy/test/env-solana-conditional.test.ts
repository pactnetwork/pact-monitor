// Env schema — Solana-conditional requireds (agent-tasks#14).
//
// A base-only proxy (PACT_ENABLED_NETWORKS=base-mainnet, no Solana env) must
// parse without throwing, so a base-only off-chain service can boot clean.
// Solana-enabled and unset (defaults to solana-devnet) configs must still
// require RPC_URL / PROGRAM_ID / USDC_MINT exactly as before — NO regression.

import { describe, test, expect } from "vitest";
import { parseEnv } from "../src/env-schema";

// Non-Solana requireds shared by every config shape below. QUEUE_BACKEND is
// left to default ("pubsub"), so PUBSUB_* must be present.
const baseRequired: Record<string, string> = {
  PG_URL: "postgresql://user:pass@host:5432/db",
  PUBSUB_PROJECT: "pact-network",
  PUBSUB_TOPIC: "pact-settle-events",
  ENDPOINTS_RELOAD_TOKEN: "0123456789abcdef0123456789abcdef",
  PORT: "8080",
};

const solanaVars: Record<string, string> = {
  RPC_URL: "https://api.devnet.solana.com",
  PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
  USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

describe("env schema — base-only boot (no Solana env)", () => {
  test("PACT_ENABLED_NETWORKS=base-mainnet parses with NO RPC_URL/PROGRAM_ID/USDC_MINT", () => {
    const parsed = parseEnv({
      ...baseRequired,
      PACT_ENABLED_NETWORKS: "base-mainnet",
    });
    expect(parsed.PACT_ENABLED_NETWORKS).toBe("base-mainnet");
    expect(parsed.RPC_URL).toBeUndefined();
    expect(parsed.PROGRAM_ID).toBeUndefined();
    expect(parsed.USDC_MINT).toBeUndefined();
  });

  test("multiple EVM networks (base-mainnet,arc-testnet) parse without Solana env", () => {
    const parsed = parseEnv({
      ...baseRequired,
      PACT_ENABLED_NETWORKS: "base-mainnet,arc-testnet",
    });
    expect(parsed.RPC_URL).toBeUndefined();
  });
});

describe("env schema — Solana-enabled requireds (no regression)", () => {
  test("unset PACT_ENABLED_NETWORKS (defaults to solana-devnet) still requires Solana vars", () => {
    // Mainnet/devnet shape with Solana vars present parses fine.
    const parsed = parseEnv({ ...baseRequired, ...solanaVars });
    expect(parsed.RPC_URL).toBe(solanaVars.RPC_URL);
    expect(parsed.PROGRAM_ID).toBe(solanaVars.PROGRAM_ID);
    expect(parsed.USDC_MINT).toBe(solanaVars.USDC_MINT);
  });

  test("unset PACT_ENABLED_NETWORKS rejects missing RPC_URL", () => {
    const env = { ...baseRequired, ...solanaVars };
    delete (env as Record<string, string>).RPC_URL;
    expect(() => parseEnv(env)).toThrow(/RPC_URL/);
  });

  test("unset PACT_ENABLED_NETWORKS rejects missing PROGRAM_ID", () => {
    const env = { ...baseRequired, ...solanaVars };
    delete (env as Record<string, string>).PROGRAM_ID;
    expect(() => parseEnv(env)).toThrow(/PROGRAM_ID/);
  });

  test("unset PACT_ENABLED_NETWORKS rejects missing USDC_MINT", () => {
    const env = { ...baseRequired, ...solanaVars };
    delete (env as Record<string, string>).USDC_MINT;
    expect(() => parseEnv(env)).toThrow(/USDC_MINT/);
  });

  test("explicit solana-devnet still requires Solana vars (missing throws)", () => {
    expect(() =>
      parseEnv({ ...baseRequired, PACT_ENABLED_NETWORKS: "solana-devnet" }),
    ).toThrow(/RPC_URL|PROGRAM_ID|USDC_MINT/);
  });

  test("unified solana-devnet,base-mainnet still requires Solana vars (missing throws)", () => {
    expect(() =>
      parseEnv({
        ...baseRequired,
        PACT_ENABLED_NETWORKS: "solana-devnet,base-mainnet",
      }),
    ).toThrow(/RPC_URL|PROGRAM_ID|USDC_MINT/);
  });

  test("unified solana-devnet,base-mainnet WITH Solana vars parses", () => {
    const parsed = parseEnv({
      ...baseRequired,
      ...solanaVars,
      PACT_ENABLED_NETWORKS: "solana-devnet,base-mainnet",
    });
    expect(parsed.RPC_URL).toBe(solanaVars.RPC_URL);
  });
});
