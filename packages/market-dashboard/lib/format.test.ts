import { describe, it, expect } from "vitest";
import { formatUsdcShort } from "./format";

// microUnits = USDC * 1_000_000
describe("formatUsdcShort", () => {
  it("formats plain amounts with a single leading $", () => {
    expect(formatUsdcShort(0)).toBe("$0.00");
    expect(formatUsdcShort(1_000_000)).toBe("$1.00");
    expect(formatUsdcShort(100_000)).toBe("$0.10");
  });

  it("abbreviates thousands and millions", () => {
    expect(formatUsdcShort(1_500_000_000)).toBe("$1.5K");
    expect(formatUsdcShort(2_000_000_000_000)).toBe("$2.00M");
  });

  it("places the minus sign before the $ for negatives", () => {
    expect(formatUsdcShort(-100_000)).toBe("-$0.10");
    expect(formatUsdcShort(-1_500_000_000)).toBe("-$1.5K");
    expect(formatUsdcShort(-2_000_000_000_000)).toBe("-$2.00M");
  });
});
