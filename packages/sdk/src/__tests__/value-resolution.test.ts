import { describe, it, expect } from "vitest";
import {
  decodeReceiptAmountUsd,
  parseX402ChallengeBody,
  resolveCallValue,
} from "../value-resolution.js";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

describe("parseX402ChallengeBody", () => {
  it("extracts amount from accepts[0].amount (USDC 6-decimal base units)", () => {
    const body = JSON.stringify({ accepts: [{ amount: "50000", asset: "USDC" }] });
    expect(parseX402ChallengeBody(body)).toBe(0.05);
  });

  it("falls back to maxAmountRequired", () => {
    const body = JSON.stringify({ accepts: [{ maxAmountRequired: "1000000" }] });
    expect(parseX402ChallengeBody(body)).toBe(1);
  });

  it("returns null on malformed body", () => {
    expect(parseX402ChallengeBody("not json")).toBeNull();
    expect(parseX402ChallengeBody("{}")).toBeNull();
    expect(parseX402ChallengeBody(JSON.stringify({ accepts: [] }))).toBeNull();
  });
});

describe("decodeReceiptAmountUsd", () => {
  it("reads amount from PAYMENT-RESPONSE header", () => {
    const h = new Headers({ "PAYMENT-RESPONSE": b64({ amount: 0.05 }) });
    expect(decodeReceiptAmountUsd(h)).toBe(0.05);
  });

  it("reads amountUsd from Payment-Receipt header", () => {
    const h = new Headers({ "Payment-Receipt": b64({ amountUsd: "1.5" }) });
    expect(decodeReceiptAmountUsd(h)).toBe(1.5);
  });

  it("returns null when no header is present", () => {
    expect(decodeReceiptAmountUsd(new Headers())).toBeNull();
  });

  it("returns null on undecodable header", () => {
    const h = new Headers({ "PAYMENT-RESPONSE": "not-base64" });
    expect(decodeReceiptAmountUsd(h)).toBeNull();
  });
});

describe("resolveCallValue precedence", () => {
  it("1 — x402 challenge wins over everything else", () => {
    const r = resolveCallValue({
      responseStatus: 402,
      responseHeaders: new Headers({
        "PAYMENT-RESPONSE": b64({ amount: 999 }),
      }),
      challengeBody: JSON.stringify({ accepts: [{ amount: "100000" }] }),
      perCallInsureUsd: 5,
      insureDefaultUsd: 1,
    });
    expect(r).toEqual({ source: "x402_challenge", amountUsd: 0.1 });
  });

  it("2 — receipt wins when challenge body is absent", () => {
    const r = resolveCallValue({
      responseStatus: 200,
      responseHeaders: new Headers({ "Payment-Receipt": b64({ amount: 0.5 }) }),
      perCallInsureUsd: 5,
      insureDefaultUsd: 1,
    });
    expect(r).toEqual({ source: "payment_response", amountUsd: 0.5 });
  });

  it("3 — per-call insure wins over default", () => {
    const r = resolveCallValue({
      responseStatus: 200,
      responseHeaders: new Headers(),
      perCallInsureUsd: 5,
      insureDefaultUsd: 1,
    });
    expect(r).toEqual({ source: "per_call_insure", amountUsd: 5 });
  });

  it("4 — insureDefault when nothing else applies", () => {
    const r = resolveCallValue({
      responseStatus: 200,
      responseHeaders: new Headers(),
      insureDefaultUsd: 0.01,
    });
    expect(r).toEqual({ source: "insure_default", amountUsd: 0.01 });
  });

  it("5 — none when no source resolves", () => {
    const r = resolveCallValue({
      responseStatus: 200,
      responseHeaders: new Headers(),
    });
    expect(r).toEqual({ source: "none", amountUsd: null });
  });

  it("ignores non-finite / negative values", () => {
    const r = resolveCallValue({
      responseStatus: 200,
      responseHeaders: new Headers(),
      perCallInsureUsd: -1,
      insureDefaultUsd: Number.NaN,
    });
    expect(r.source).toBe("none");
  });

  it("402 without challenge body falls through to receipt / default", () => {
    const r = resolveCallValue({
      responseStatus: 402,
      responseHeaders: new Headers(),
      insureDefaultUsd: 0.01,
    });
    expect(r).toEqual({ source: "insure_default", amountUsd: 0.01 });
  });
});
