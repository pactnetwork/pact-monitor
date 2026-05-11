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
