import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC,
  EXPECTED_USDC_DECIMALS,
} from "../src/constants.js";

const chainsPath = join(
  __dirname,
  "../../program-evm/protocol-evm-v1/config/chains.json",
);
const chains = JSON.parse(readFileSync(chainsPath, "utf-8")) as Record<
  string,
  { chainId: number; usdcAddress: string; usdcDecimals: number }
>;

describe("chain-table drift — chains.json vs constants.ts", () => {
  it("arc-testnet chainId matches constants.ts export", () => {
    expect(chains["arc-testnet"].chainId).toBe(ARC_TESTNET_CHAIN_ID);
  });

  it("arc-testnet USDC address matches constants.ts export (case-insensitive)", () => {
    expect(chains["arc-testnet"].usdcAddress.toLowerCase()).toBe(
      ARC_TESTNET_USDC.toLowerCase(),
    );
  });

  it("every chain's usdcDecimals equals protocol-wide EXPECTED_USDC_DECIMALS", () => {
    for (const [name, c] of Object.entries(chains)) {
      expect(c.usdcDecimals, `${name}.usdcDecimals`).toBe(
        EXPECTED_USDC_DECIMALS,
      );
    }
  });
});
