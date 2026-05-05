import { describe, expect, test } from "bun:test";
import { Envelope, exitCodeFor, statuses } from "../src/lib/envelope.ts";

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
    expect(exitCodeFor("cli_internal_error")).toBe(99);
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
