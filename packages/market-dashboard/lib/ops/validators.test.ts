import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  validateBigIntNonNeg,
  validatePercentBps,
  validatePubkey,
  validateRecipients,
  validateSlug,
  validateUsdcDecimal,
  type RecipientRow,
} from "./validators";

const PK_OK = "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1";

describe("validateSlug", () => {
  it("accepts lowercase alphanumeric + dash, 1..16 chars", () => {
    for (const s of ["a", "abc", "acme-api", "a1-b2-c3", "0123456789abcdef"]) {
      const r = validateSlug(s);
      expect(r.ok).toBe(true);
    }
  });
  it("rejects empty / uppercase / >16 / illegal chars", () => {
    for (const s of ["", "ACME", "acme api", "a".repeat(17), "underscore_bad"]) {
      const r = validateSlug(s);
      expect(r.ok).toBe(false);
    }
  });
  it("trims whitespace", () => {
    const r = validateSlug("  acme  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("acme");
  });
});

describe("validatePubkey", () => {
  it("returns a PublicKey for a valid base58", () => {
    const r = validatePubkey(PK_OK);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeInstanceOf(PublicKey);
  });
  it("rejects malformed input", () => {
    for (const s of ["", "not-a-pubkey!!", "0".repeat(50)]) {
      expect(validatePubkey(s).ok).toBe(false);
    }
  });
});

describe("validateBigIntNonNeg", () => {
  it("parses 0 and positive ints", () => {
    expect(validateBigIntNonNeg("0", "x").ok).toBe(true);
    const r = validateBigIntNonNeg("123456789012345", "x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(123456789012345n);
  });
  it("rejects decimals / negatives / non-numerics", () => {
    for (const s of ["1.5", "-1", "abc", "", " "]) {
      expect(validateBigIntNonNeg(s, "x").ok).toBe(false);
    }
  });
});

describe("validatePercentBps", () => {
  it("accepts 0..10000", () => {
    expect(validatePercentBps(0).ok).toBe(true);
    expect(validatePercentBps(5000).ok).toBe(true);
    expect(validatePercentBps(10000).ok).toBe(true);
  });
  it("rejects out-of-range and non-integer", () => {
    expect(validatePercentBps(-1).ok).toBe(false);
    expect(validatePercentBps(10001).ok).toBe(false);
    expect(validatePercentBps(1.5).ok).toBe(false);
  });
  it("coerces strings", () => {
    expect(validatePercentBps("500").ok).toBe(true);
    expect(validatePercentBps("abc").ok).toBe(false);
  });
});

describe("validateUsdcDecimal", () => {
  it("converts decimal USDC to base units (×10^6)", () => {
    const cases: Array<[string, bigint]> = [
      ["1", 1_000_000n],
      ["1.5", 1_500_000n],
      ["0.000001", 1n],
      ["123.456789", 123_456_789n],
    ];
    for (const [input, expected] of cases) {
      const r = validateUsdcDecimal(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(expected);
    }
  });
  it("rejects negatives / zero / >6 decimals / non-numeric", () => {
    for (const s of ["", "0", "-1", "1.2345678", "abc"]) {
      expect(validateUsdcDecimal(s).ok).toBe(false);
    }
  });
});

describe("validateRecipients — sum cap is ≤ max_total_fee_bps, NOT === 10000", () => {
  function row(
    kind: RecipientRow["kind"],
    destination: string,
    bps: string,
  ): RecipientRow {
    return { id: Math.random().toString(36).slice(2), kind, destination, bps };
  }

  it("accepts sum < max_total_fee_bps (the chain accepts any ≤ cap; residual stays in pool)", () => {
    const rows = [row("Treasury", PK_OK, "500")];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(true);
    expect(r.sumBps).toBe(500);
    expect(r.formErrors).toEqual([]);
  });

  it("accepts sum === max_total_fee_bps exactly", () => {
    const rows = [
      row("Treasury", PK_OK, "1500"),
      row("AffiliateAta", PK_OK, "1500"),
    ];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(true);
  });

  it("rejects sum > max_total_fee_bps", () => {
    const rows = [
      row("Treasury", PK_OK, "2000"),
      row("AffiliateAta", PK_OK, "2000"),
    ];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(false);
    expect(r.formErrors.join(" ")).toMatch(/sum of bps/);
  });

  it("requires exactly one Treasury entry", () => {
    const rows = [row("AffiliateAta", PK_OK, "500")];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(false);
    expect(r.formErrors.join(" ")).toMatch(/Treasury/);
  });

  it("rejects multiple Treasury entries", () => {
    const rows = [
      row("Treasury", PK_OK, "500"),
      row("Treasury", PK_OK, "500"),
    ];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(false);
    expect(r.formErrors.join(" ")).toMatch(/exactly one Treasury/);
  });

  it("requires Treasury bps > 0", () => {
    const rows = [
      row("Treasury", PK_OK, "0"),
      row("AffiliateAta", PK_OK, "500"),
    ];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(false);
    expect(r.formErrors.join(" ")).toMatch(/Treasury.*bps/);
  });

  it("caps recipient count at 8", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row(i === 0 ? "Treasury" : "AffiliateAta", PK_OK, "100"),
    );
    const r = validateRecipients(rows, 10000);
    expect(r.ok).toBe(false);
    expect(r.formErrors.join(" ")).toMatch(/max 8/);
  });

  it("per-row errors on bad pubkey / bad bps; doesn't crash", () => {
    const rows = [
      row("Treasury", PK_OK, "500"),
      row("AffiliateAta", "not-a-pubkey", "100"),
      row("AffiliateAta", PK_OK, "20000"),
    ];
    const r = validateRecipients(rows, 3000);
    expect(r.ok).toBe(false);
    expect(Object.keys(r.rowErrors)).toHaveLength(2);
  });

  it("at least one recipient required", () => {
    const r = validateRecipients([], 3000);
    expect(r.ok).toBe(false);
    expect(r.formErrors.join(" ")).toMatch(/at least one/);
  });
});
