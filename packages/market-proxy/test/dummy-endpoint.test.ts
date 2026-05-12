// Tests for the `dummy` endpoint handler + its registry/classifier wiring.
//
// Mirrors the surface of upstream-headers.test.ts (header allowlist) and
// classifier.test.ts (status-based outcomes), but scoped to the demo
// upstream `https://dummy.pactnetwork.io`.
//
// We exercise:
//   - URL rewrite: /v1/dummy/<rest>?<q> → <upstreamBase>/<rest>?<q> — i.e.
//     strip the `/v1/<slug>` gateway prefix, then strip pact_wallet / demo_breach
//   - header allowlist: base headers forwarded, Authorization / Cookie /
//     X-API-KEY dropped (dummy is unauthenticated, like Jupiter)
//   - isInsurableMethod → always true (plain GET upstream)
//   - registry + classifier registration: handlerRegistry["dummy"] and
//     classifierRegistry["dummy"] both resolve, classifier is the
//     status-based default

import { describe, test, expect } from "vitest";
import { dummyHandler } from "../src/endpoints/dummy.js";
import { handlerRegistry } from "../src/lib/registry.js";
import { classifierRegistry } from "../src/lib/classifiers.js";
import type { ClassifierInput } from "@pact-network/wrap";

const UPSTREAM_BASE = "https://dummy.pactnetwork.io";

function makeIncoming(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Request {
  const init: RequestInit & { duplex?: string } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify({});
    init.duplex = "half";
  }
  return new Request(`https://api.pactnetwork.io${path}`, init as RequestInit);
}

describe("dummy endpoint handler", () => {
  test("rewrites /v1/dummy/<rest> → upstreamBase/<rest> (strips the /v1/<slug> prefix)", async () => {
    const req = makeIncoming("/v1/dummy/quote/AAPL");
    const upstream = await dummyHandler.buildRequest(req, UPSTREAM_BASE);
    const u = new URL(upstream.url);
    expect(u.origin).toBe("https://dummy.pactnetwork.io");
    expect(u.pathname).toBe("/quote/AAPL");
  });

  test("preserves upstream-relevant query params", async () => {
    const req = makeIncoming("/v1/dummy/quote/AAPL?fail=1&latency=2500");
    const upstream = await dummyHandler.buildRequest(req, UPSTREAM_BASE);
    const u = new URL(upstream.url);
    expect(u.searchParams.get("fail")).toBe("1");
    expect(u.searchParams.get("latency")).toBe("2500");
  });

  test("strips pact_wallet and demo_breach query params", async () => {
    const req = makeIncoming(
      "/v1/dummy/quote/AAPL?fail=1&pact_wallet=AgentPubkey111&demo_breach=1",
    );
    const upstream = await dummyHandler.buildRequest(req, UPSTREAM_BASE);
    const u = new URL(upstream.url);
    expect(u.searchParams.get("pact_wallet")).toBeNull();
    expect(u.searchParams.get("demo_breach")).toBeNull();
    expect(u.searchParams.get("fail")).toBe("1");
  });

  test("forwards base allowlist headers, drops Authorization / Cookie / X-API-KEY", async () => {
    const req = makeIncoming("/v1/dummy/quote/AAPL", {
      "Content-Type": "application/json",
      Accept: "*/*",
      Authorization: "Bearer caller-secret",
      Cookie: "session=abc",
      "X-API-KEY": "caller-key",
      Host: "evil.example.com",
    });
    const upstream = await dummyHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.get("accept")).toBe("*/*");
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("x-api-key")).toBeNull();
    expect(upstream.headers.get("host")).toBeNull();
  });

  test("preserves the HTTP method", async () => {
    const req = makeIncoming("/v1/dummy/quote/AAPL");
    const upstream = await dummyHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.method).toBe("GET");
  });

  test("isInsurableMethod is always true", async () => {
    const req = makeIncoming("/v1/dummy/quote/AAPL");
    expect(await dummyHandler.isInsurableMethod(req)).toBe(true);
    const health = makeIncoming("/v1/dummy/health");
    expect(await dummyHandler.isInsurableMethod(health)).toBe(true);
  });
});

describe("dummy registry + classifier wiring", () => {
  test("handlerRegistry exposes the dummy handler", () => {
    expect(handlerRegistry.dummy).toBe(dummyHandler);
  });

  test("classifierRegistry registers a static (status-based) classifier for dummy", () => {
    const factory = classifierRegistry.dummy;
    expect(factory).toBeDefined();
    expect(factory.kind).toBe("static");
  });

  const baseEndpointConfig: ClassifierInput["endpointConfig"] = {
    sla_latency_ms: 2000,
    flat_premium_lamports: 1_000n,
    imputed_cost_lamports: 5_000n,
  };

  function classifyDummy(input: ClassifierInput) {
    const factory = classifierRegistry.dummy;
    if (factory.kind !== "static") throw new Error("expected static factory");
    return factory.classifier.classify(input);
  }

  test("503 (?fail=1) → server_error, full premium + refund", () => {
    const r = classifyDummy({
      response: new Response("upstream failed", { status: 503 }),
      latencyMs: 50,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("server_error");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(5_000n);
  });

  test("2xx over SLA (?latency=...) → latency_breach, premium + refund", () => {
    const r = classifyDummy({
      response: new Response(JSON.stringify({ symbol: "AAPL", price: 1 }), {
        status: 200,
      }),
      latencyMs: 2_500,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("latency_breach");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(5_000n);
  });

  test("2xx within SLA → ok, premium charged, no refund", () => {
    const r = classifyDummy({
      response: new Response(JSON.stringify({ symbol: "AAPL", price: 1 }), {
        status: 200,
      }),
      latencyMs: 120,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(0n);
  });

  test("402 (?x402=1) → client_error, no premium, no refund (agent fault under default SLA)", () => {
    const r = classifyDummy({
      response: new Response("payment required", { status: 402 }),
      latencyMs: 40,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
    expect(r.refund).toBe(0n);
  });

  test("network error (response=null) → network_error, premium + refund", () => {
    const r = classifyDummy({
      response: null,
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("network_error");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(5_000n);
  });
});
