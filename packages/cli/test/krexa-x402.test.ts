import { describe, expect, test } from "bun:test";
import {
  parseKrexaChallenge,
  selectKrexaSolanaRequirements,
} from "../src/lib/krexa-x402.ts";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

const KREXA_REQS = {
  scheme: "exact",
  network: "solana",
  amount: "5000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  payTo: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
  maxTimeoutSeconds: 300,
};

const KREXA_BODY = {
  x402Version: 2,
  accepts: [KREXA_REQS],
  resource: {
    url: "/api/v1/solana/compute/<agent>/complete",
    description: "Claude Haiku completion",
  },
};

describe("krexa challenge parser", () => {
  test("parses base64 envelope from PAYMENT-REQUIRED header (no X- prefix)", () => {
    const c = parseKrexaChallenge({
      headers: { "payment-required": b64(KREXA_BODY) },
    });
    expect(c).not.toBeNull();
    expect(c!.x402Version).toBe(2);
    expect(c!.accepts).toHaveLength(1);
    expect(c!.accepts[0].amountBaseUnits).toBe("5000");
    expect(c!.accepts[0].asset).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(c!.accepts[0].payTo).toBe(
      "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
    );
  });

  test("header lookup is case-insensitive", () => {
    const c = parseKrexaChallenge({
      headers: { "PAYMENT-REQUIRED": b64(KREXA_BODY) },
    });
    expect(c).not.toBeNull();
  });

  test("falls back to JSON body when header missing", () => {
    const c = parseKrexaChallenge({
      headers: {},
      body: JSON.stringify(KREXA_BODY),
    });
    expect(c).not.toBeNull();
    expect(c!.accepts[0].network).toBe("solana");
  });

  test("returns null when neither header nor body carries a valid challenge", () => {
    expect(parseKrexaChallenge({ headers: {} })).toBeNull();
    expect(parseKrexaChallenge({ headers: {}, body: "not json" })).toBeNull();
    expect(
      parseKrexaChallenge({
        headers: { "payment-required": "!!!not-base64-json!!!" },
      }),
    ).toBeNull();
  });

  test("accepts legacy `recipient` and `maxAmountRequired` field aliases", () => {
    const legacy = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "solana",
          maxAmountRequired: "5000",
          asset: KREXA_REQS.asset,
          recipient: KREXA_REQS.payTo,
        },
      ],
    };
    const c = parseKrexaChallenge({
      headers: { "payment-required": b64(legacy) },
    });
    expect(c).not.toBeNull();
    expect(c!.accepts[0].amountBaseUnits).toBe("5000");
    expect(c!.accepts[0].payTo).toBe(KREXA_REQS.payTo);
  });

  test("rejects challenges with empty accepts list", () => {
    const c = parseKrexaChallenge({
      headers: { "payment-required": b64({ x402Version: 2, accepts: [] }) },
    });
    expect(c).toBeNull();
  });
});

describe("krexa requirement selection", () => {
  test("picks first Solana network when no preference given", () => {
    const c = parseKrexaChallenge({
      headers: { "payment-required": b64(KREXA_BODY) },
    })!;
    const r = selectKrexaSolanaRequirements(c);
    expect(r).not.toBeNull();
    expect(r!.network).toBe("solana");
  });

  test("honors preferredNetwork when matching candidate exists", () => {
    const multi = {
      x402Version: 2,
      accepts: [
        { ...KREXA_REQS, network: "solana-devnet" },
        { ...KREXA_REQS, network: "solana" },
      ],
    };
    const c = parseKrexaChallenge({
      headers: { "payment-required": b64(multi) },
    })!;
    const r = selectKrexaSolanaRequirements(c, "solana");
    expect(r!.network).toBe("solana");
  });

  test("returns null when no Solana network is offered", () => {
    const ethOnly = {
      x402Version: 2,
      accepts: [{ ...KREXA_REQS, network: "ethereum" }],
    };
    const c = parseKrexaChallenge({
      headers: { "payment-required": b64(ethOnly) },
    });
    expect(c).not.toBeNull();
    expect(selectKrexaSolanaRequirements(c!)).toBeNull();
  });
});
