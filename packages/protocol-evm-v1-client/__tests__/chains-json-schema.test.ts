import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress } from "viem";

const chainsPath = join(
  __dirname,
  "../../program-evm/protocol-evm-v1/config/chains.json",
);

describe("chains.json — schema shape", () => {
  const raw = readFileSync(chainsPath, "utf-8");
  const chains = JSON.parse(raw) as Record<string, unknown>;

  it("file exists and is a non-empty object", () => {
    expect(typeof chains).toBe("object");
    expect(chains).not.toBeNull();
    expect(Object.keys(chains).length).toBeGreaterThan(0);
  });

  it("every chain has the four required fields with correct types", () => {
    for (const [name, raw] of Object.entries(chains)) {
      const c = raw as Record<string, unknown>;
      expect(typeof c.chainId, `${name}.chainId`).toBe("number");
      expect(typeof c.name, `${name}.name`).toBe("string");
      expect(c.name, `${name}.name === key`).toBe(name);
      expect(typeof c.usdcAddress, `${name}.usdcAddress`).toBe("string");
      expect(
        isAddress(c.usdcAddress as string),
        `${name}.usdcAddress is EIP-55 address`,
      ).toBe(true);
      expect(typeof c.usdcDecimals, `${name}.usdcDecimals`).toBe("number");
    }
  });

  it("D6 reserved fields are present and either null or correctly typed", () => {
    for (const [name, raw] of Object.entries(chains)) {
      const c = raw as Record<string, unknown>;
      for (const key of ["rpcUrl", "blockTimeMs", "finalityBlocks"] as const) {
        expect(key in c, `${name}.${key} is reserved`).toBe(true);
      }
      expect(
        c.rpcUrl === null || typeof c.rpcUrl === "string",
        `${name}.rpcUrl null or string`,
      ).toBe(true);
      expect(
        c.blockTimeMs === null || typeof c.blockTimeMs === "number",
        `${name}.blockTimeMs null or number`,
      ).toBe(true);
      expect(
        c.finalityBlocks === null || typeof c.finalityBlocks === "number",
        `${name}.finalityBlocks null or number`,
      ).toBe(true);
    }
  });

  it("arc-testnet entry matches the known chain id and USDC", () => {
    const arc = chains["arc-testnet"] as Record<string, unknown>;
    expect(arc.chainId).toBe(5042002);
    expect((arc.usdcAddress as string).toLowerCase()).toBe(
      "0x3600000000000000000000000000000000000000",
    );
    expect(arc.usdcDecimals).toBe(6);
  });
});
