import { describe, expect, test } from "bun:test";
import { USDC_DEVNET_MINT, PACT_NETWORK_V1_PROGRAM_ID } from "../src/lib/solana.ts";

describe("solana helpers", () => {
  test("USDC_DEVNET_MINT is correct", () => {
    expect(USDC_DEVNET_MINT.toBase58()).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  test("PACT_NETWORK_V1_PROGRAM_ID matches Step C devnet deploy", () => {
    expect(PACT_NETWORK_V1_PROGRAM_ID.toBase58()).toBe(
      "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    );
  });
});
