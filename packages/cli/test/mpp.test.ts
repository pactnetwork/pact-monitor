import { describe, expect, test } from "bun:test";
import {
  parseChallengesFromHeaders,
  parseChallengesFromHeaderValues,
  isSessionChallenge,
  HEADER_WWW_AUTHENTICATE,
  SCHEME_SOLANA_CHARGE,
} from "../src/lib/mpp.ts";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

const SAMPLE_CHARGE = {
  amount: "10000",
  currency: "USDC",
  recipient: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
  description: "AAPL quote",
  method_details: { network: "mainnet" },
};

describe("mpp parser", () => {
  test("parses a SolanaCharge challenge from www-authenticate", () => {
    const header = `${SCHEME_SOLANA_CHARGE} realm="api.example.com", charge="${b64(SAMPLE_CHARGE)}"`;
    const challenges = parseChallengesFromHeaders({
      [HEADER_WWW_AUTHENTICATE]: header,
    });
    expect(challenges).toHaveLength(1);
    expect(challenges[0].realm).toBe("api.example.com");
    expect(challenges[0].charge.amount).toBe("10000");
    expect(challenges[0].charge.currency).toBe("USDC");
    expect(challenges[0].charge.method_details?.network).toBe("mainnet");
  });

  test("ignores non-SolanaCharge schemes (Bearer, Basic, …)", () => {
    const header = `Bearer realm="x", Basic realm="y"`;
    const challenges = parseChallengesFromHeaders({
      [HEADER_WWW_AUTHENTICATE]: header,
    });
    expect(challenges).toHaveLength(0);
  });

  test("handles multiple challenges in one header", () => {
    const header = [
      `Bearer realm="legacy"`,
      `${SCHEME_SOLANA_CHARGE} realm="a.com", charge="${b64({ ...SAMPLE_CHARGE, amount: "100" })}"`,
      `${SCHEME_SOLANA_CHARGE} realm="b.com", charge="${b64({ ...SAMPLE_CHARGE, amount: "200" })}"`,
    ].join(", ");
    const challenges = parseChallengesFromHeaderValues([header]);
    expect(challenges).toHaveLength(2);
    expect(challenges[0].charge.amount).toBe("100");
    expect(challenges[1].charge.amount).toBe("200");
  });

  test("handles repeated www-authenticate headers (array form)", () => {
    const challenges = parseChallengesFromHeaders({
      [HEADER_WWW_AUTHENTICATE]: [
        `${SCHEME_SOLANA_CHARGE} realm="a.com", charge="${b64(SAMPLE_CHARGE)}"`,
        `${SCHEME_SOLANA_CHARGE} realm="b.com", charge="${b64({ ...SAMPLE_CHARGE, currency: "PYUSD" })}"`,
      ],
    });
    expect(challenges).toHaveLength(2);
    expect(challenges[1].charge.currency).toBe("PYUSD");
  });

  test("rejects malformed charge (missing required fields)", () => {
    const broken = b64({ amount: "100" });
    const header = `${SCHEME_SOLANA_CHARGE} charge="${broken}"`;
    expect(parseChallengesFromHeaderValues([header])).toHaveLength(0);
  });

  test("isSessionChallenge flags intent=session", () => {
    const sessionCharge = b64({ ...SAMPLE_CHARGE, intent: "session", cap: "1000000" });
    const oneShotCharge = b64(SAMPLE_CHARGE);
    const cs = parseChallengesFromHeaderValues([
      `${SCHEME_SOLANA_CHARGE} charge="${sessionCharge}"`,
      `${SCHEME_SOLANA_CHARGE} charge="${oneShotCharge}"`,
    ]);
    expect(cs).toHaveLength(2);
    expect(isSessionChallenge(cs[0])).toBe(true);
    expect(isSessionChallenge(cs[1])).toBe(false);
  });
});
