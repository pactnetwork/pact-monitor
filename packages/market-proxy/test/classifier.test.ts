// Tests the per-endpoint classifier plugins (composed with wrap's
// defaultClassifier) live in src/lib/classifiers.ts.
//
// We exercise:
//   - Helius JSON-RPC body inspection (server-side codes -> server_error,
//     client-side codes -> client_error)
//   - Helius fall-through to default (no body, non-200, etc.)
//   - Birdeye / Jupiter use the default classifier directly

import { describe, test, expect } from "vitest";
import {
  buildHeliusClassifier,
  marketDefaultClassifier,
} from "../src/lib/classifiers.js";
import { heliusHandler } from "../src/endpoints/helius.js";
import type { ClassifierInput } from "@pact-network/wrap";

const baseEndpointConfig: ClassifierInput["endpointConfig"] = {
  sla_latency_ms: 1200,
  flat_premium_lamports: 500n,
  imputed_cost_lamports: 50_000n,
};

describe("Helius classifier (composed with default)", () => {
  test("2xx within SLA → ok, flat premium, no refund", () => {
    const c = buildHeliusClassifier(() => null);
    const r = c.classify({
      response: new Response(JSON.stringify({ result: {} }), { status: 200 }),
      latencyMs: 800,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(500n);
    expect(r.refund).toBe(0n);
  });

  test("2xx over SLA → latency_breach, refund", () => {
    const c = buildHeliusClassifier(() => null);
    const r = c.classify({
      response: new Response(JSON.stringify({ result: {} }), { status: 200 }),
      latencyMs: 1500,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("latency_breach");
    expect(r.premium).toBe(500n);
    expect(r.refund).toBe(50_000n);
  });

  test("5xx → server_error, refund (default rule)", () => {
    const c = buildHeliusClassifier(() => null);
    const r = c.classify({
      response: new Response("error", { status: 503 }),
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("server_error");
    expect(r.refund).toBe(50_000n);
  });

  test("429 → client_error, no premium (default rule)", () => {
    const c = buildHeliusClassifier(() => null);
    const r = c.classify({
      response: new Response("rate limited", { status: 429 }),
      latencyMs: 50,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
    expect(r.refund).toBe(0n);
  });

  test("JSON-RPC error -32603 (internal) → server_error, refund", () => {
    const c = buildHeliusClassifier(() => ({
      jsonrpc: "2.0",
      error: { code: -32603, message: "internal" },
    }));
    const r = c.classify({
      response: new Response("{}", { status: 200 }),
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("server_error");
    expect(r.premium).toBe(500n);
    expect(r.refund).toBe(50_000n);
  });

  test("JSON-RPC error -32602 (invalid params) → client_error, no premium", () => {
    const c = buildHeliusClassifier(() => ({
      jsonrpc: "2.0",
      error: { code: -32602, message: "invalid params" },
    }));
    const r = c.classify({
      response: new Response("{}", { status: 200 }),
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
  });

  test("JSON-RPC error -32000 (server-defined) → server_error, refund", () => {
    const c = buildHeliusClassifier(() => ({
      jsonrpc: "2.0",
      error: { code: -32000, message: "server defined" },
    }));
    const r = c.classify({
      response: new Response("{}", { status: 200 }),
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("server_error");
  });

  test("non-200 with body → falls through to default rule", () => {
    // Even if the body has an error, a non-200 response is classified by
    // the HTTP-status default rules, not the JSON-RPC plugin.
    const c = buildHeliusClassifier(() => ({
      jsonrpc: "2.0",
      error: { code: -32603 },
    }));
    const r = c.classify({
      response: new Response("err", { status: 503 }),
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("server_error"); // 503 default
  });

  test("network error (response=null) → server_error, refund", () => {
    const c = buildHeliusClassifier(() => null);
    const r = c.classify({
      response: null,
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    // wrap's default treats null as network_error; refund = imputed.
    expect(r.outcome).toBe("network_error");
    expect(r.refund).toBe(50_000n);
  });
});

describe("market default classifier (Birdeye, Jupiter, Elfa, fal)", () => {
  test("2xx within SLA → ok", () => {
    const r = marketDefaultClassifier.classify({
      response: new Response("{}", { status: 200 }),
      latencyMs: 400,
      endpointConfig: { ...baseEndpointConfig, sla_latency_ms: 800 },
    });
    expect(r.outcome).toBe("ok");
  });

  test("2xx over SLA → latency_breach", () => {
    const r = marketDefaultClassifier.classify({
      response: new Response("{}", { status: 200 }),
      latencyMs: 1000,
      endpointConfig: { ...baseEndpointConfig, sla_latency_ms: 800 },
    });
    expect(r.outcome).toBe("latency_breach");
  });

  test("5xx → server_error with refund", () => {
    const r = marketDefaultClassifier.classify({
      response: new Response("err", { status: 500 }),
      latencyMs: 100,
      endpointConfig: baseEndpointConfig,
    });
    expect(r.outcome).toBe("server_error");
    expect(r.refund).toBe(baseEndpointConfig.imputed_cost_lamports);
  });
});

describe("Helius handler", () => {
  test("isInsurableMethod true for getAccountInfo", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getAccountInfo", params: [] });
    const req = new Request("http://proxy/v1/helius/", { method: "POST", body });
    expect(await heliusHandler.isInsurableMethod(req)).toBe(true);
  });

  test("isInsurableMethod false for unrecognised method", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getRecentBlockhash", params: [] });
    const req = new Request("http://proxy/v1/helius/", { method: "POST", body });
    expect(await heliusHandler.isInsurableMethod(req)).toBe(false);
  });
});
