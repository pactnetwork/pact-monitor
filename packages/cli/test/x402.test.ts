import { describe, expect, test } from "bun:test";
import {
  parseChallenge,
  selectSolanaRequirements,
  isPaymentRejection,
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_REQUIRED_V1,
  X402_VERSION_V1,
  X402_VERSION_V2,
  type X402Challenge,
} from "../src/lib/x402.ts";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

const MAIN_REQS = {
  scheme: "exact",
  network: "solana",
  maxAmountRequired: "10000",
  resource: "https://api.example.com/quote",
  description: "AAPL quote",
  payTo: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

describe("x402 parser", () => {
  test("parses v2 envelope from X-Payment-Required header", () => {
    const env = { x402Version: 2, accepts: [MAIN_REQS] };
    const c = parseChallenge({
      headers: { [HEADER_PAYMENT_REQUIRED_V2]: b64(env) },
    });
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(X402_VERSION_V2);
    expect(c!.accepts).toHaveLength(1);
    expect(c!.accepts[0].network).toBe("solana");
    expect(c!.accepts[0].maxAmountRequired).toBe("10000");
  });

  test("parses v1 envelope from X-Payment-Required-V1 header", () => {
    const env = { x402Version: 1, accepts: [MAIN_REQS] };
    const c = parseChallenge({
      headers: { [HEADER_PAYMENT_REQUIRED_V1]: b64(env) },
    });
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(X402_VERSION_V1);
  });

  test("falls back to JSON body when header is absent", () => {
    const env = { x402Version: 2, accepts: [MAIN_REQS] };
    const c = parseChallenge({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    expect(c).not.toBeNull();
    expect(c!.accepts[0].resource).toBe(MAIN_REQS.resource);
  });

  test("returns null when no challenge present", () => {
    const c = parseChallenge({ headers: {} });
    expect(c).toBeNull();
  });

  test("ignores malformed base64 / json", () => {
    const c = parseChallenge({
      headers: { [HEADER_PAYMENT_REQUIRED_V2]: "!!!not-base64!!!" },
    });
    expect(c).toBeNull();
  });

  test("accepts legacy `recipient`/`amount` keys (sandbox compat)", () => {
    const env = {
      x402Version: 2,
      accepts: [
        {
          ...MAIN_REQS,
          payTo: undefined,
          recipient: MAIN_REQS.payTo,
          maxAmountRequired: undefined,
          amount: MAIN_REQS.maxAmountRequired,
        },
      ],
    };
    const c = parseChallenge({
      headers: { [HEADER_PAYMENT_REQUIRED_V2]: b64(env) },
    });
    expect(c).not.toBeNull();
    expect(c!.accepts[0].payTo).toBe(MAIN_REQS.payTo);
    expect(c!.accepts[0].maxAmountRequired).toBe(MAIN_REQS.maxAmountRequired);
  });

  test("selectSolanaRequirements prefers preferred network", () => {
    const c: X402Challenge = {
      x402Version: 2,
      accepts: [
        { ...MAIN_REQS, network: "solana-devnet" },
        { ...MAIN_REQS, network: "solana" },
        { ...MAIN_REQS, network: "ethereum" },
      ],
    };
    expect(selectSolanaRequirements(c, "solana")?.network).toBe("solana");
    expect(selectSolanaRequirements(c, "solana-devnet")?.network).toBe(
      "solana-devnet",
    );
    expect(selectSolanaRequirements(c)?.network).toBe("solana-devnet");
  });

  test("isPaymentRejection detects verification_failed body", () => {
    const r = isPaymentRejection({
      headers: {},
      body: JSON.stringify({ error: "verification_failed", reason: "expired" }),
    });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("expired");
  });

  test("isPaymentRejection returns false on a normal challenge body", () => {
    const r = isPaymentRejection({
      headers: {},
      body: JSON.stringify({ x402Version: 2, accepts: [MAIN_REQS] }),
    });
    expect(r.rejected).toBe(false);
  });
});
