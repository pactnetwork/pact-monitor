import { describe, expect, test } from "bun:test";
import { Envelope, buildInternalErrorEnvelope, exitCodeFor, statuses } from "../src/lib/envelope.ts";

describe("envelope", () => {
  test("status set is closed and exhaustive", () => {
    expect(statuses).toEqual([
      "ok",
      "client_error",
      "server_error",
      "needs_funding",
      "auto_deposit_capped",
      "endpoint_paused",
      "no_provider",
      "discovery_unreachable",
      "signature_rejected",
      "needs_project_name",
      "x402_payment_made",
      "mpp_payment_made",
      "payment_failed",
      "unsupported_tool",
      "tool_missing",
      "tool_error",
      "cli_internal_error",
    ]);
  });

  test("exit codes match spec", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("client_error")).toBe(0);
    expect(exitCodeFor("server_error")).toBe(0);
    expect(exitCodeFor("needs_funding")).toBe(10);
    expect(exitCodeFor("auto_deposit_capped")).toBe(11);
    expect(exitCodeFor("endpoint_paused")).toBe(12);
    expect(exitCodeFor("no_provider")).toBe(20);
    expect(exitCodeFor("discovery_unreachable")).toBe(21);
    expect(exitCodeFor("signature_rejected")).toBe(30);
    expect(exitCodeFor("needs_project_name")).toBe(40);
    expect(exitCodeFor("x402_payment_made")).toBe(0);
    expect(exitCodeFor("mpp_payment_made")).toBe(0);
    expect(exitCodeFor("payment_failed")).toBe(31);
    expect(exitCodeFor("unsupported_tool")).toBe(50);
    expect(exitCodeFor("tool_missing")).toBe(51);
    expect(exitCodeFor("tool_error")).toBe(0);
    expect(exitCodeFor("cli_internal_error")).toBe(99);
  });

  describe("buildInternalErrorEnvelope (B3)", () => {
    test("body contains error message but no stack field", () => {
      const err = new Error("boom");
      const env = buildInternalErrorEnvelope(err);
      expect(env.status).toBe("cli_internal_error");
      const body = env.body as Record<string, unknown>;
      expect(body.error).toBe("boom");
      expect(body).not.toHaveProperty("stack");
      expect(Object.keys(body)).toEqual(["error"]);
    });

    test("non-Error throwables are coerced to string without leaking stack", () => {
      const env = buildInternalErrorEnvelope("plain string failure");
      const body = env.body as Record<string, unknown>;
      expect(body.error).toBe("plain string failure");
      expect(body).not.toHaveProperty("stack");
    });
  });

  test("Envelope type accepts a known status", () => {
    const e: Envelope = {
      status: "ok",
      body: { hello: "world" },
      meta: {
        slug: "helius",
        call_id: "call_test_1",
        latency_ms: 100,
        outcome: "ok",
        premium_lamports: 100,
        premium_usdc: 0.0001,
        tx_signature: null,
        settlement_eta_sec: 5,
      },
    };
    expect(e.status).toBe("ok");
  });
});
