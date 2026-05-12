// Fixture-driven regression tests for the pay 0.16.0 classifier. Each
// fixture pair (stdout + stderr) under fixtures/pay-016/ is loaded
// verbatim and replayed through classifyPayResult. If pay's output
// format drifts again, these fail loudly instead of silently producing
// payment.attempted=false envelopes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPayResult } from "../src/lib/pay-classifier.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "pay-016");

function loadFixture(name: string): { stdout: string; stderr: string } {
  return {
    stdout: readFileSync(join(FIXTURE_DIR, `${name}.stdout`), "utf8"),
    stderr: readFileSync(join(FIXTURE_DIR, `${name}.stderr`), "utf8"),
  };
}

describe("pay 0.16.0 fixture: mpp-success", () => {
  const { stdout, stderr } = loadFixture("mpp-success");

  test("classifier reports payment attempted with USDC amount", () => {
    const r = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });
    expect(r.outcome).toBe("success");
    expect(r.payment.attempted).toBe(true);
    expect(r.payment.signed).toBe(true);
    expect(r.payment.asset).toBe("USDC");
    // "Building MPP credential amount=10000" with USDC@6 decimals → 0.01.
    expect(r.payment.amount).toBe("0.01");
    expect(r.upstreamStatus).toBe(200);
  });
});

describe("pay 0.16.0 fixture: x402-success", () => {
  const { stdout, stderr } = loadFixture("x402-success");

  test("classifier reports payment attempted with USDC amount", () => {
    const r = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });
    expect(r.outcome).toBe("success");
    expect(r.payment.attempted).toBe(true);
    expect(r.payment.signed).toBe(true);
    expect(r.payment.amount).toBe("0.05");
    expect(r.payment.asset).toBe("USDC");
    expect(r.upstreamStatus).toBe(200);
  });
});

describe("pay 0.16.0 fixture: curl-non402", () => {
  const { stdout, stderr } = loadFixture("curl-non402");

  test("classifier reports no payment for free passthrough", () => {
    const r = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });
    expect(r.outcome).toBe("success");
    expect(r.payment.attempted).toBe(false);
    expect(r.payment.signed).toBe(false);
    expect(r.payment.amount).toBeNull();
    expect(r.payment.asset).toBeNull();
    expect(r.upstreamStatus).toBe(200);
  });
});

describe("pay 0.13.0/0.16.0 fixture: x402-buildline-success", () => {
  const { stdout, stderr } = loadFixture("x402-buildline-success");

  test("classifier extracts amount (base units), mint, payee, signer from the x402 build line", () => {
    const r = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });
    expect(r.outcome).toBe("success");
    expect(r.payment.attempted).toBe(true);
    expect(r.payment.scheme).toBe("x402");
    // `amount=5000` on the build line is already base units.
    expect(r.payment.amountBaseUnits).toBe("5000");
    // USDC mint → human-readable 0.005, asset "USDC".
    expect(r.payment.amount).toBe("0.005");
    expect(r.payment.asset).toBe("USDC");
    expect(r.payment.assetMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    // `recipient=` → the merchant/payee.
    expect(r.payment.payeePubkey).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
    // `signer=` → the agent's own pubkey (matched via SIGNER_HINT_RE).
    expect(r.payment.signerPubkey).toBe("Ba8rnWKKvVwrD9CNL6BSjooWE9jZmj2zzBzNVjxSwd25");
    // stdout's `[pact-http-status=200]` marker → upstream status.
    expect(r.upstreamStatus).toBe(200);
  });
});

describe("pay 0.13.0 fixture: x402-buildline-013 (plain, no tracing layer)", () => {
  const { stdout, stderr } = loadFixture("x402-buildline-013");

  test("classifier parses the plain (non-ANSI) x402 build line too", () => {
    const r = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });
    expect(r.payment.attempted).toBe(true);
    expect(r.payment.scheme).toBe("x402");
    expect(r.payment.amountBaseUnits).toBe("5000");
    expect(r.payment.assetMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(r.payment.payeePubkey).toBe("9xQeWvG816bUx9EPm2Mz1cVqYqRyVQK9Q6Gz3vQF1pT");
    expect(r.upstreamStatus).toBe(200);
    expect(r.outcome).toBe("success");
  });
});

describe("pay fixture: x402-buildline-5xx (curl -w marker → server_error)", () => {
  const { stdout, stderr } = loadFixture("x402-buildline-5xx");

  test("a 503 surfaced via the [pact-http-status=503] marker classifies server_error", () => {
    const r = classifyPayResult({ payExitCode: 0, stdoutText: stdout, stderrText: stderr });
    // Payment settled (the x402 build line is present) but the upstream
    // 503'd — the SLA-breach / refund path.
    expect(r.payment.attempted).toBe(true);
    expect(r.upstreamStatus).toBe(503);
    expect(r.outcome).toBe("server_error");
  });

  test("[pact-http-status=200] still classifies success (happy path unaffected)", () => {
    const r = classifyPayResult({
      payExitCode: 0,
      stdoutText: '{"ok":true}\n[pact-http-status=200]\n',
      stderrText: stderr,
    });
    expect(r.upstreamStatus).toBe(200);
    expect(r.outcome).toBe("success");
  });
});

describe("PACT_HTTP_STATUS_RE: curl -w marker parsing", () => {
  // No payment attempted — plain `pact pay curl` of a free endpoint that
  // 503s. The injected marker is still the source of the status.
  test("[pact-http-status=503] with no 402 → upstreamStatus 503", () => {
    const r = classifyPayResult({
      payExitCode: 0,
      stdoutText: "boom\n[pact-http-status=503]\n",
      stderrText: "",
    });
    expect(r.payment.attempted).toBe(false);
    expect(r.upstreamStatus).toBe(503);
  });

  test("the pact marker wins over a stray `http_code=` in the body", () => {
    const r = classifyPayResult({
      payExitCode: 0,
      stdoutText: '{"http_code":"200"}\n[pact-http-status=502]\n',
      stderrText: "",
    });
    expect(r.upstreamStatus).toBe(502);
  });
});
