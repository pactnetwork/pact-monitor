import { describe, test, expect } from "vitest";
import { heliusHandler } from "../src/endpoints/helius.js";
import { birdeyeHandler } from "../src/endpoints/birdeye.js";
import { jupiterHandler } from "../src/endpoints/jupiter.js";
import type { EndpointRow } from "../src/lib/endpoints.js";

const endpoint: EndpointRow = {
  slug: "helius",
  flatPremiumLamports: 500n,
  percentBps: 10,
  slaLatencyMs: 1200,
  imputedCostLamports: 50000n,
  exposureCapPerHourLamports: 1000000n,
  paused: false,
  upstreamBase: "https://mainnet.helius-rpc.com",
  displayName: "Helius RPC",
};

describe("Helius classifier", () => {
  test("2xx within SLA → ok, flat premium, no refund", async () => {
    const resp = new Response(JSON.stringify({ result: {} }), { status: 200 });
    const r = await heliusHandler.classify(resp, 800, endpoint);
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(500n);
    expect(r.refund).toBe(0n);
    expect(r.breach).toBe(false);
  });

  test("2xx over SLA → breach latency, refund", async () => {
    const resp = new Response(JSON.stringify({ result: {} }), { status: 200 });
    const r = await heliusHandler.classify(resp, 1500, endpoint);
    expect(r.outcome).toBe("server_error");
    expect(r.premium).toBe(500n);
    expect(r.refund).toBe(50000n);
    expect(r.breach).toBe(true);
    expect(r.reason).toBe("latency");
  });

  test("5xx → breach, refund", async () => {
    const resp = new Response("error", { status: 503 });
    const r = await heliusHandler.classify(resp, 100, endpoint);
    expect(r.outcome).toBe("server_error");
    expect(r.breach).toBe(true);
    expect(r.reason).toBe("5xx");
    expect(r.refund).toBe(50000n);
  });

  test("429 → no premium, no refund", async () => {
    const resp = new Response("rate limited", { status: 429 });
    const r = await heliusHandler.classify(resp, 50, endpoint);
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
    expect(r.refund).toBe(0n);
    expect(r.breach).toBe(false);
  });

  test("JSON-RPC error -32603 → server_error, refund", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal" } });
    const resp = new Response(body, { status: 200 });
    const r = await heliusHandler.classify(resp, 100, endpoint);
    expect(r.outcome).toBe("server_error");
    expect(r.refund).toBe(50000n);
  });

  test("JSON-RPC error -32602 → client_error, no premium", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "invalid params" } });
    const resp = new Response(body, { status: 200 });
    const r = await heliusHandler.classify(resp, 100, endpoint);
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
  });

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

describe("Birdeye classifier", () => {
  const beEndpoint: EndpointRow = { ...endpoint, slug: "birdeye", slaLatencyMs: 800, upstreamBase: "https://public-api.birdeye.so" };

  test("2xx within SLA → ok", async () => {
    const resp = new Response("{}", { status: 200 });
    const r = await birdeyeHandler.classify(resp, 400, beEndpoint);
    expect(r.outcome).toBe("ok");
    expect(r.breach).toBe(false);
  });

  test("2xx over SLA → breach latency", async () => {
    const resp = new Response("{}", { status: 200 });
    const r = await birdeyeHandler.classify(resp, 1000, beEndpoint);
    expect(r.breach).toBe(true);
    expect(r.reason).toBe("latency");
  });

  test("isInsurableMethod always true", async () => {
    const req = new Request("http://proxy/v1/birdeye/price", { method: "GET" });
    expect(await birdeyeHandler.isInsurableMethod(req)).toBe(true);
  });
});

describe("Jupiter classifier", () => {
  const jupEndpoint: EndpointRow = { ...endpoint, slug: "jupiter", slaLatencyMs: 600, upstreamBase: "https://quote-api.jup.ag" };

  test("2xx within SLA → ok", async () => {
    const resp = new Response("{}", { status: 200 });
    const r = await jupiterHandler.classify(resp, 300, jupEndpoint);
    expect(r.outcome).toBe("ok");
  });

  test("5xx → server_error with refund", async () => {
    const resp = new Response("err", { status: 500 });
    const r = await jupiterHandler.classify(resp, 100, jupEndpoint);
    expect(r.outcome).toBe("server_error");
    expect(r.refund).toBe(jupEndpoint.imputedCostLamports);
  });
});
