// Tests for building the facilitator coverage-registration payload from
// the pay 0.16.0 classifier output, using the captured fixtures under
// fixtures/pay-016/.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPayResult } from "../src/lib/pay-classifier.ts";
import {
  buildCoveragePayload,
  missingReceiptFields,
  outcomeToVerdict,
  shouldRegisterCoverage,
} from "../src/lib/x402-receipt.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "pay-016");
function loadFixture(name: string): { stdout: string; stderr: string } {
  return {
    stdout: readFileSync(join(FIXTURE_DIR, `${name}.stdout`), "utf8"),
    stderr: readFileSync(join(FIXTURE_DIR, `${name}.stderr`), "utf8"),
  };
}

const AGENT = "AgentPubkey1111111111111111111111111111111111";

describe("buildCoveragePayload: x402-success fixture", () => {
  const { stdout, stderr } = loadFixture("x402-success");
  const classified = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });

  test("classifier extracts scheme + resource from the x402 verbose trace", () => {
    expect(classified.payment.attempted).toBe(true);
    expect(classified.payment.scheme).toBe("x402");
    // The fixture's `resource="https://example.x402/quote/AAPL"`.
    expect(classified.payment.resource).toBe("https://example.x402/quote/AAPL");
    // "402 Payment Required (x402) — 0.05 USDC" → 0.05 → 50000 base units @6.
    expect(classified.payment.amountBaseUnits).toBe("50000");
    expect(classified.payment.asset).toBe("USDC");
    // x402 body line carries no `signer=`/tx sig — both null.
    expect(classified.payment.signerPubkey).toBeNull();
    expect(classified.payment.txSignature).toBeNull();
  });

  test("payload carries agent, scheme, resource, amountBaseUnits, asset (mint), verdict", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.agent).toBe(AGENT);
    expect(payload.scheme).toBe("x402");
    expect(payload.resource).toBe("https://example.x402/quote/AAPL");
    expect(payload.amountBaseUnits).toBe("50000");
    // USDC symbol → canonical mint.
    expect(payload.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(payload.verdict).toBe("success");
    expect(payload.upstreamStatus).toBe(200);
    // pay 0.16.0 doesn't log the payee or the settle tx sig — absent.
    expect(payload.payee).toBeUndefined();
    expect(payload.paymentSignature).toBeUndefined();
    // JSON wire form must not carry the absent fields as null.
    const wire = JSON.parse(JSON.stringify(payload));
    expect("payee" in wire).toBe(false);
    expect("paymentSignature" in wire).toBe(false);
  });

  test("missingReceiptFields flags payee + paymentSignature", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    const missing = missingReceiptFields(payload);
    expect(missing).toContain("payee");
    expect(missing).toContain("paymentSignature");
    expect(missing).not.toContain("resource");
    expect(missing).not.toContain("amountBaseUnits");
    expect(missing).not.toContain("asset");
  });
});

describe("buildCoveragePayload: mpp-success fixture", () => {
  const { stdout, stderr } = loadFixture("mpp-success");
  const classified = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });

  test("classifier extracts scheme=mpp, resource, mint, base units, signer", () => {
    expect(classified.payment.scheme).toBe("mpp");
    expect(classified.payment.resource).toBe("https://debugger.pay.sh/mpp/quote/AAPL");
    // "Building MPP credential amount=10000 currency=EPjFW…" → base units = 10000.
    expect(classified.payment.amountBaseUnits).toBe("10000");
    expect(classified.payment.assetMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    // The fixture logs `signer=Ba8rnWKKvVwrD9CNL6BSjooWE9jZmj2zzBzNVjxSwd25`.
    expect(classified.payment.signerPubkey).toBe("Ba8rnWKKvVwrD9CNL6BSjooWE9jZmj2zzBzNVjxSwd25");
    // pay 0.16.0 still doesn't surface the settle tx sig.
    expect(classified.payment.txSignature).toBeNull();
  });

  test("payload uses the SPL mint for asset and the MPP base-unit amount", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.scheme).toBe("mpp");
    expect(payload.resource).toBe("https://debugger.pay.sh/mpp/quote/AAPL");
    expect(payload.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(payload.amountBaseUnits).toBe("10000");
    expect(payload.verdict).toBe("success");
    expect(payload.paymentSignature).toBeUndefined();
  });
});

describe("buildCoveragePayload: curl-non402 fixture (free passthrough)", () => {
  const { stdout, stderr } = loadFixture("curl-non402");
  const classified = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });

  test("no payment attempted → shouldRegisterCoverage is false", () => {
    expect(classified.payment.attempted).toBe(false);
    expect(shouldRegisterCoverage(classified)).toBe(false);
  });
});

describe("outcomeToVerdict mapping", () => {
  test("maps each classifier outcome to the facilitator verdict", () => {
    expect(outcomeToVerdict("success")).toBe("success");
    expect(outcomeToVerdict("server_error")).toBe("server_error");
    expect(outcomeToVerdict("client_error")).toBe("client_error");
    expect(outcomeToVerdict("payment_failed")).toBe("payment_failed");
    expect(outcomeToVerdict("tool_error")).toBe("tool_error");
  });
});

describe("buildCoveragePayload: synthetic 5xx verdict", () => {
  test("server_error outcome → server_error verdict, upstreamStatus carried", () => {
    const classified = classifyPayResult({
      payExitCode: 0,
      stdoutText: "upstream timeout status=503",
      stderrText:
        'Detected x402 challenge resource="https://flaky.example/v1/q"\n' +
        "402 Payment Required (x402) — 0.05 USDC\nPaying...\nPayment signed, retrying...\n",
    });
    expect(classified.outcome).toBe("server_error");
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.verdict).toBe("server_error");
    expect(payload.upstreamStatus).toBe(503);
    expect(payload.resource).toBe("https://flaky.example/v1/q");
  });

  test("a future pay build that logs `tx=<sig>` populates paymentSignature", () => {
    const fakeSig = "5".repeat(64); // base58-ish, 64 chars
    const classified = classifyPayResult({
      payExitCode: 0,
      stdoutText: "ok status=200",
      stderrText:
        'Detected x402 challenge resource="https://x.example/r"\n' +
        "402 Payment Required (x402) — 0.05 USDC\n" +
        `Payment signed, retrying... tx=${fakeSig}\n`,
    });
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.paymentSignature).toBe(fakeSig);
    expect(missingReceiptFields(payload)).not.toContain("paymentSignature");
  });
});

describe("buildCoveragePayload: x402-buildline-success fixture (pay 0.13/0.16 x402 auto-pay)", () => {
  const { stdout, stderr } = loadFixture("x402-buildline-success");
  const classified = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });

  test("classifier surfaces amountBaseUnits, asset (mint), payee, signer from the build line", () => {
    expect(classified.payment.attempted).toBe(true);
    expect(classified.payment.scheme).toBe("x402");
    expect(classified.payment.amountBaseUnits).toBe("5000");
    expect(classified.payment.assetMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(classified.payment.payeePubkey).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
    expect(classified.payment.signerPubkey).toBe("Ba8rnWKKvVwrD9CNL6BSjooWE9jZmj2zzBzNVjxSwd25");
  });

  test("payload carries amountBaseUnits, asset=mint, payee=recipient", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.agent).toBe(AGENT);
    expect(payload.scheme).toBe("x402");
    // amountBaseUnits is the integer string from `amount=5000` — exactly
    // what the facilitator's `amountBaseUnits must be an integer string`
    // check wants (the bug this fixes was sending null here).
    expect(payload.amountBaseUnits).toBe("5000");
    expect(payload.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    // payee is the merchant — `recipient=` on the build line.
    expect(payload.payee).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
    expect(payload.resource).toBe("https://dummy.pactnetwork.io/quote/AAPL");
    expect(payload.verdict).toBe("success");
    expect(payload.upstreamStatus).toBe(200);
    // On wire: present, non-null.
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire.amountBaseUnits).toBe("5000");
    expect(wire.payee).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
  });

  test("missingReceiptFields does NOT flag amountBaseUnits / asset / payee here", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    const missing = missingReceiptFields(payload);
    expect(missing).not.toContain("amountBaseUnits");
    expect(missing).not.toContain("asset");
    expect(missing).not.toContain("payee");
  });
});

describe("buildCoveragePayload: x402-buildline-5xx fixture (covered failure receipt)", () => {
  const { stdout, stderr } = loadFixture("x402-buildline-5xx");
  const classified = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });

  test("verdict=server_error, amountBaseUnits + payee still populated", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.verdict).toBe("server_error");
    expect(payload.upstreamStatus).toBe(503);
    expect(payload.amountBaseUnits).toBe("5000");
    expect(payload.payee).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
  });
});

describe("buildCoveragePayload: x402-buildline-013 (plain variant)", () => {
  const { stdout, stderr } = loadFixture("x402-buildline-013");
  const classified = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });

  test("payee/amount still extracted from the non-ANSI build line", () => {
    const payload = buildCoveragePayload({ agentPubkey: AGENT, classified });
    expect(payload.amountBaseUnits).toBe("5000");
    expect(payload.payee).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
    expect(payload.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});
