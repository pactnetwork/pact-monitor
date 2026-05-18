import { describe, it, expect } from "vitest";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC,
  EXPECTED_USDC_DECIMALS,
  MAX_BATCH_SIZE,
  MIN_PREMIUM,
  MAX_FEE_RECIPIENTS,
  ABSOLUTE_FEE_BPS_CAP,
  DEFAULT_MAX_TOTAL_FEE_BPS,
  PactRegistryAbi,
  PactPoolAbi,
  PactSettlerAbi,
  PactEventsAbi,
  PactErrorsAbi,
} from "../src/constants.js";

// Parity oracle: ArcConfig.sol == constants.rs (design spec §3 invariants).
// Values are bit-identical across both source authorities; constants.ts must
// not drift from either.
describe("constants — parity with ArcConfig.sol / constants.rs", () => {
  it("Arc Testnet network constants match ArcConfig.sol", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
    expect(ARC_TESTNET_USDC).toBe(
      "0x3600000000000000000000000000000000000000",
    );
    expect(EXPECTED_USDC_DECIMALS).toBe(6);
  });

  it("protocol parity invariants match constants.rs (spec §3)", () => {
    expect(MAX_BATCH_SIZE).toBe(50);
    expect(MIN_PREMIUM).toBe(100n);
    expect(MAX_FEE_RECIPIENTS).toBe(8);
    expect(ABSOLUTE_FEE_BPS_CAP).toBe(10_000);
    expect(DEFAULT_MAX_TOTAL_FEE_BPS).toBe(3_000);
  });

  it("re-exports the committed contract ABIs (spec §5: constants.ts ABI re-export)", () => {
    for (const abi of [
      PactRegistryAbi,
      PactPoolAbi,
      PactSettlerAbi,
      PactEventsAbi,
      PactErrorsAbi,
    ]) {
      expect(Array.isArray(abi)).toBe(true);
      expect(abi.length).toBeGreaterThan(0);
    }
    // PactErrors mirrors error.rs's 30-variant set (handoff §(b) ruling 1).
    expect(PactErrorsAbi.filter((x) => x.type === "error")).toHaveLength(30);
    // PactEvents is the 7-event indexer truth source (design spec §4 #3).
    expect(PactEventsAbi.filter((x) => x.type === "event")).toHaveLength(7);
  });
});
