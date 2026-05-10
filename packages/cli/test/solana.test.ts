import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PACT_NETWORK_V1_PROGRAM_ID,
  USDC_MAINNET_MINT,
  resolveClusterConfig,
} from "../src/lib/solana.ts";

describe("solana helpers", () => {
  const originalEnabled = process.env.PACT_MAINNET_ENABLED;
  beforeEach(() => {
    delete process.env.PACT_MAINNET_ENABLED;
  });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.PACT_MAINNET_ENABLED;
    else process.env.PACT_MAINNET_ENABLED = originalEnabled;
  });

  test("USDC_MAINNET_MINT matches the canonical mainnet USDC mint", () => {
    expect(USDC_MAINNET_MINT.toBase58()).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  test("PACT_NETWORK_V1_PROGRAM_ID matches the baked mainnet program ID", () => {
    expect(PACT_NETWORK_V1_PROGRAM_ID.toBase58()).toBe(
      "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc",
    );
  });

  test("resolveClusterConfig returns canonical mainnet pair when gate is open", () => {
    process.env.PACT_MAINNET_ENABLED = "1";
    const cfg = resolveClusterConfig();
    if ("error" in cfg) throw new Error("expected ClusterConfig, got error");
    expect(cfg.programId.toBase58()).toBe(
      "5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc",
    );
    expect(cfg.mint.toBase58()).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  test("resolveClusterConfig returns client_error when PACT_MAINNET_ENABLED is closed", () => {
    const cfg = resolveClusterConfig();
    if (!("error" in cfg)) throw new Error("expected error, got ClusterConfig");
    expect(cfg.error).toContain("PACT_MAINNET_ENABLED");
  });
});
