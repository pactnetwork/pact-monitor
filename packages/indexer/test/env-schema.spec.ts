// Indexer env schema — contract parity for EVM-only deploys (agent-tasks#12).
//
// Three canonical cases:
//   (a) Mainnet-style snapshot: no PACT_ENABLED_NETWORKS → defaults to
//       solana-devnet → SOLANA_RPC_URL + PROGRAM_ID required.
//   (b) EVM-only: PACT_ENABLED_NETWORKS=base-mainnet → Solana vars not required.
//   (c) Solana-enabled without SOLANA_RPC_URL → throws.

import { parseEnv } from "../src/env-schema";

// ---------------------------------------------------------------------------
// (a) Mainnet-style snapshot (no PACT_ENABLED_NETWORKS key)
// ---------------------------------------------------------------------------
// Mirrors a typical mainnet indexer Cloud Run env. No PACT_ENABLED_NETWORKS
// means hasSolanaNetwork sees "solana-devnet" (default) → Solana vars required.
const mainnetEnvSnapshot: Record<string, string> = {
  PG_URL: "postgresql://pact:secret@db.example.com:5432/pact",
  INDEXER_PUSH_SECRET: "0123456789abcdef0123456789abcdef",
  SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=redacted",
  PROGRAM_ID: "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc",
  LOG_LEVEL: "log",
  PORT: "3001",
  // NOTE: no PACT_ENABLED_NETWORKS
};

// ---------------------------------------------------------------------------
// (b) EVM-only env (PACT_ENABLED_NETWORKS=base-mainnet)
// ---------------------------------------------------------------------------
const evmOnlyEnvSnapshot: Record<string, string> = {
  PG_URL: "postgresql://pact:secret@db.example.com:5432/pact",
  PACT_ENABLED_NETWORKS: "base-mainnet",
  INDEXER_PUSH_SECRET: "0123456789abcdef0123456789abcdef",
  LOG_LEVEL: "log",
  PORT: "3001",
  // NOTE: no SOLANA_RPC_URL, no PROGRAM_ID
};

describe("indexer env schema — mainnet snapshot (no PACT_ENABLED_NETWORKS)", () => {
  it("(a) parses mainnet snapshot and requires SOLANA_RPC_URL + PROGRAM_ID", () => {
    const env = parseEnv(mainnetEnvSnapshot);
    expect(env.SOLANA_RPC_URL).toBe(
      "https://mainnet.helius-rpc.com/?api-key=redacted",
    );
    expect(env.PROGRAM_ID).toBe("5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc");
    expect(env.PACT_ENABLED_NETWORKS).toBeUndefined();
  });

  it("(a) rejects mainnet snapshot without SOLANA_RPC_URL", () => {
    const e = { ...mainnetEnvSnapshot };
    delete e.SOLANA_RPC_URL;
    expect(() => parseEnv(e)).toThrow(/SOLANA_RPC_URL/);
  });

  it("(a) rejects mainnet snapshot without PROGRAM_ID", () => {
    const e = { ...mainnetEnvSnapshot };
    delete e.PROGRAM_ID;
    expect(() => parseEnv(e)).toThrow(/PROGRAM_ID/);
  });
});

describe("indexer env schema — EVM-only deploy (agent-tasks#12)", () => {
  it("(b) EVM-only env parses without SOLANA_RPC_URL or PROGRAM_ID", () => {
    const env = parseEnv(evmOnlyEnvSnapshot);
    expect(env.PACT_ENABLED_NETWORKS).toBe("base-mainnet");
    expect(env.SOLANA_RPC_URL).toBeUndefined();
    expect(env.PROGRAM_ID).toBeUndefined();
    expect(env.PG_URL).toContain("pact");
  });

  it("(b) EVM-only env with per-network RPC override also parses", () => {
    // PACT_RPC_URL_BASE_MAINNET is a dynamic key resolved at runtime — it is
    // not enumerated in the Zod schema (would require an escape hatch like
    // z.record() or passthrough). The schema does not reject unknown keys by
    // default (Zod strips them). This test documents that the schema does not
    // interfere with per-network RPC override keys.
    const env = parseEnv({
      ...evmOnlyEnvSnapshot,
      PACT_RPC_URL_BASE_MAINNET: "https://mainnet.base.org",
    });
    expect(env.PACT_ENABLED_NETWORKS).toBe("base-mainnet");
    expect(env.SOLANA_RPC_URL).toBeUndefined();
  });
});

describe("indexer env schema — Solana-conditional enforcement (agent-tasks#12)", () => {
  it("(c) solana-enabled env without SOLANA_RPC_URL throws", () => {
    const e: Record<string, string> = {
      ...mainnetEnvSnapshot,
      PACT_ENABLED_NETWORKS: "solana-devnet",
    };
    delete e.SOLANA_RPC_URL;
    expect(() => parseEnv(e)).toThrow(/SOLANA_RPC_URL/);
  });

  it("(c) solana-enabled env without PROGRAM_ID throws", () => {
    const e: Record<string, string> = {
      ...mainnetEnvSnapshot,
      PACT_ENABLED_NETWORKS: "solana-devnet",
    };
    delete e.PROGRAM_ID;
    expect(() => parseEnv(e)).toThrow(/PROGRAM_ID/);
  });

  it("mixed solana+evm list still requires Solana vars when solana-* is present", () => {
    const e: Record<string, string> = {
      ...mainnetEnvSnapshot,
      PACT_ENABLED_NETWORKS: "base-mainnet,solana-mainnet",
    };
    delete e.SOLANA_RPC_URL;
    expect(() => parseEnv(e)).toThrow(/SOLANA_RPC_URL/);
  });

  it("PG_URL is always required", () => {
    const e = { ...evmOnlyEnvSnapshot };
    delete e.PG_URL;
    expect(() => parseEnv(e)).toThrow();
  });

  it("INDEXER_PUSH_SECRET is always required", () => {
    const e = { ...evmOnlyEnvSnapshot };
    delete e.INDEXER_PUSH_SECRET;
    expect(() => parseEnv(e)).toThrow();
  });

  it("PORT defaults to 3001 when not provided", () => {
    const e = { ...evmOnlyEnvSnapshot };
    delete e.PORT;
    const env = parseEnv(e);
    expect(env.PORT).toBe(3001);
  });
});
