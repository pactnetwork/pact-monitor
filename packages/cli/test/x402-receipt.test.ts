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
