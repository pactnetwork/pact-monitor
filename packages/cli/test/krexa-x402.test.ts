import { describe, expect, test } from "bun:test";
import {
  HEADER_KREXA_RETRY,
  HEADER_KREXA_RETRY_TOKEN,
  buildKrexaRetryHeaders,
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

describe("krexa retry header construction", () => {
  // The Krexa publishing-x402-service spec requires the retry payload to
  // be carried in TWO headers (PAYMENT-SIGNATURE + X-Payment-Token), both
  // set to base64(JSON.stringify({signature})) — matching @krexa/cli's
  // `krexa x402 call` retry behaviour (dist/commands/x402.js).
  const FAKE_SIG =
    "5N4iCxJVuVnTcVeqfHrh1uA1Q3rDS1xfP1XQDi9Lj1ggEAcfQ7iqJqRBkpQ8E9zL2dN5GfRwNCqXqEgKQ7nqYx8r";

  test("header names match spec (PAYMENT-SIGNATURE + X-Payment-Token)", () => {
    expect(HEADER_KREXA_RETRY).toBe("PAYMENT-SIGNATURE");
    expect(HEADER_KREXA_RETRY_TOKEN).toBe("X-Payment-Token");
  });

  test("both header values are identical base64-JSON {signature}", () => {
    const h = buildKrexaRetryHeaders(FAKE_SIG);
    expect(h.paymentSignature).toBe(h.xPaymentToken);
    expect(h.value).toBe(h.paymentSignature);

    // Round-trip decode confirms the wire shape.
    const decoded = JSON.parse(
      Buffer.from(h.paymentSignature, "base64").toString("utf8"),
    );
    expect(decoded).toEqual({ signature: FAKE_SIG });

    // Sanity: bare base58 sig string is NOT what we ship (regression
    // guard against the old PR #126 implementation).
    expect(h.paymentSignature).not.toBe(FAKE_SIG);
  });

  test("different signatures produce different tokens", () => {
    const a = buildKrexaRetryHeaders(FAKE_SIG);
    const b = buildKrexaRetryHeaders(FAKE_SIG + "X");
    expect(a.value).not.toBe(b.value);
  });
});
