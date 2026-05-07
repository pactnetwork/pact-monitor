import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import {
  buildEnvelope,
  buildX402PaymentHeader,
  buildMppCredentialHeader,
  decodeEnvelope,
  verifyEnvelopeSignature,
  PACT_PAYMENT_SCHEME,
  PACT_PAYMENT_VERSION,
} from "../src/lib/pay-auth.ts";
import { HEADER_PAYMENT_V2 } from "../src/lib/x402.ts";
import { HEADER_AUTHORIZATION, SCHEME_SOLANA_CHARGE } from "../src/lib/mpp.ts";

function fixedInput() {
  const keypair = Keypair.generate();
  return {
    keypair,
    resource: "https://api.example.com/v1/quote/AAPL",
    recipient: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
    amount: "10000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    network: "solana",
    now: () => 1_700_000_000_000,
    randomNonce: () => new Uint8Array(16).fill(7),
  };
}

describe("pay-auth", () => {
  test("envelope round-trips and signature verifies", () => {
    const input = fixedInput();
    const { base64, envelope } = buildEnvelope(input);
    const decoded = decodeEnvelope(base64) as typeof envelope;
    expect(decoded).toEqual(envelope);
    expect(verifyEnvelopeSignature(decoded as never)).toBe(true);
  });

  test("envelope shape carries scheme + version + canonical fields", () => {
    const input = fixedInput();
    const { envelope } = buildEnvelope(input);
    const e = envelope as Record<string, unknown>;
    expect(e.scheme).toBe(PACT_PAYMENT_SCHEME);
    expect(e.version).toBe(PACT_PAYMENT_VERSION);
    expect(e.network).toBe("solana");
    const p = e.payload as Record<string, unknown>;
    expect(p.agent).toBe(input.keypair.publicKey.toBase58());
    expect(p.resource).toBe(input.resource);
    expect(p.recipient).toBe(input.recipient);
    expect(p.amount).toBe(input.amount);
    expect(p.asset).toBe(input.asset);
    expect(p.timestampMs).toBe(1_700_000_000_000);
  });

  test("buildX402PaymentHeader names the v2 retry header", () => {
    const h = buildX402PaymentHeader(fixedInput());
    expect(h.name).toBe(HEADER_PAYMENT_V2);
    expect(h.value.length).toBeGreaterThan(0);
    expect(() => decodeEnvelope(h.value)).not.toThrow();
  });

  test("buildMppCredentialHeader emits SolanaCharge credential", () => {
    const h = buildMppCredentialHeader(fixedInput());
    expect(h.name).toBe(HEADER_AUTHORIZATION);
    expect(h.value.startsWith(`${SCHEME_SOLANA_CHARGE} credential="`)).toBe(true);
    const m = h.value.match(/credential="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(() => decodeEnvelope(m![1])).not.toThrow();
  });

  test("tampering with payload invalidates signature", () => {
    const input = fixedInput();
    const { envelope } = buildEnvelope(input);
    const tampered = JSON.parse(JSON.stringify(envelope)) as ReturnType<
      typeof buildEnvelope
    >["envelope"];
    (tampered as { payload: { amount: string } }).payload.amount = "99999999";
    expect(verifyEnvelopeSignature(tampered as never)).toBe(false);
  });
});
