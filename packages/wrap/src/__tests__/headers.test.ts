import { describe, it, expect } from "vitest";
import { HEADERS, attachPactHeaders } from "../headers";

describe("attachPactHeaders", () => {
  it("attaches all standard X-Pact-* headers", () => {
    const original = new Response("hello", { status: 200 });
    const out = attachPactHeaders(original, {
      callId: "abc-123",
      outcome: "ok",
      premiumLamports: 1000n,
      refundLamports: 0n,
      latencyMs: 42,
      pool: "helius-mainnet",
      settlementPending: true,
    });
    expect(out.headers.get(HEADERS.PREMIUM)).toBe("1000");
    expect(out.headers.get(HEADERS.REFUND)).toBe("0");
    expect(out.headers.get(HEADERS.LATENCY_MS)).toBe("42");
    expect(out.headers.get(HEADERS.OUTCOME)).toBe("ok");
    expect(out.headers.get(HEADERS.POOL)).toBe("helius-mainnet");
    expect(out.headers.get(HEADERS.SETTLEMENT_PENDING)).toBe("1");
    expect(out.headers.get("X-Pact-Call-Id")).toBe("abc-123");
  });

  it("omits pool and settlement-pending when not provided", () => {
    const out = attachPactHeaders(new Response("x", { status: 500 }), {
      callId: "id",
      outcome: "server_error",
      premiumLamports: 500n,
      refundLamports: 200n,
      latencyMs: 1234,
    });
    expect(out.headers.get(HEADERS.POOL)).toBeNull();
    expect(out.headers.get(HEADERS.SETTLEMENT_PENDING)).toBeNull();
  });

  it("does not mutate the original response's headers", () => {
    const original = new Response("body", {
      status: 200,
      headers: { "x-original": "1" },
    });
    const before = original.headers.get(HEADERS.PREMIUM);
    const out = attachPactHeaders(original, {
      callId: "id",
      outcome: "ok",
      premiumLamports: 1n,
      refundLamports: 0n,
      latencyMs: 1,
    });
    expect(before).toBeNull();
    // Original remains untouched.
    expect(original.headers.get(HEADERS.PREMIUM)).toBeNull();
    expect(original.headers.get("x-original")).toBe("1");
    // New response has both pre-existing and new headers.
    expect(out.headers.get("x-original")).toBe("1");
    expect(out.headers.get(HEADERS.PREMIUM)).toBe("1");
  });

  it("preserves status, statusText, and body", async () => {
    const out = attachPactHeaders(
      new Response("payload", { status: 201, statusText: "Created" }),
      {
        callId: "id",
        outcome: "ok",
        premiumLamports: 0n,
        refundLamports: 0n,
        latencyMs: 0,
      },
    );
    expect(out.status).toBe(201);
    expect(out.statusText).toBe("Created");
    expect(await out.text()).toBe("payload");
  });

  it("serializes large bigints as decimal strings", () => {
    const big = 18_446_744_073_709_551_615n; // u64 max
    const out = attachPactHeaders(new Response(""), {
      callId: "id",
      outcome: "ok",
      premiumLamports: big,
      refundLamports: big,
      latencyMs: 0,
    });
    expect(out.headers.get(HEADERS.PREMIUM)).toBe(big.toString());
    expect(out.headers.get(HEADERS.REFUND)).toBe(big.toString());
  });
});
