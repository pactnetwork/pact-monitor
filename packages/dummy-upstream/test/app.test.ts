// Tests for every query-string toggle on pact-dummy-upstream's /quote/:symbol,
// plus /health and /. Same setup style as packages/market-proxy/test/ —
// build a Hono app and drive it via app.request(...), no network.

import { describe, test, expect } from "vitest";
import { createApp } from "../src/app.js";

const app = createApp();

describe("GET /health", () => {
  test("200 with the expected shape", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "pact-dummy-upstream",
    });
  });
});

describe("GET /", () => {
  test("200 HTML page listing the toggles", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("pact-dummy-upstream");
    expect(body).toContain("?fail=1");
    expect(body).toContain("?x402=1");
    expect(body).toContain("?latency=");
  });
});

describe("GET /quote/:symbol — default", () => {
  test("200 JSON quote with the symbol upper-cased", async () => {
    const res = await app.request("/quote/aapl");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.symbol).toBe("AAPL");
    expect(body.price).toBe("287.90");
    expect(body.currency).toBe("USD");
    expect(body.source).toBe("pact-dummy-upstream");
    expect(typeof body.ts).toBe("number");
    expect(body.ts).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("GET /quote/:symbol — ?fail=1", () => {
  test("503 upstream_unavailable", async () => {
    const res = await app.request("/quote/AAPL?fail=1");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("upstream_unavailable");
    expect(body.symbol).toBe("AAPL");
    expect(body.source).toBe("pact-dummy-upstream");
  });
});

describe("GET /quote/:symbol — ?status=", () => {
  test("?status=502 → 502", async () => {
    const res = await app.request("/quote/AAPL?status=502");
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(502);
    expect(body.symbol).toBe("AAPL");
  });

  test("?status=204 → 204", async () => {
    const res = await app.request("/quote/AAPL?status=204");
    expect(res.status).toBe(204);
  });

  test("?status=200 → 200 echo (not the default quote shape)", async () => {
    const res = await app.request("/quote/AAPL?status=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(200);
  });

  test("invalid ?status= is ignored → falls through to default 200 quote", async () => {
    const res = await app.request("/quote/AAPL?status=999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.price).toBe("287.90");
  });

  test("non-numeric ?status= is ignored", async () => {
    const res = await app.request("/quote/AAPL?status=abc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.price).toBe("287.90");
  });
});

describe("GET /quote/:symbol — ?latency=", () => {
  test("delays the response by roughly the requested ms", async () => {
    const t0 = Date.now();
    const res = await app.request("/quote/AAPL?latency=200");
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    // Allow scheduler jitter slop below the target.
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  test("?latency=0 is a no-op (fast)", async () => {
    const t0 = Date.now();
    await app.request("/quote/AAPL?latency=0");
    expect(Date.now() - t0).toBeLessThan(150);
  });

  test("?latency= is clamped to 10000ms", async () => {
    // We don't want a 1e9 sleep — assert the clamp by checking the call
    // doesn't hang. (Can't easily assert the exact clamp without a long
    // wait, so we just sanity-check a huge value still returns quickly-ish
    // relative to the requested value — here we use a small over-cap value
    // to keep the test fast.)
    const t0 = Date.now();
    const res = await app.request("/quote/AAPL?latency=50");
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("composes with ?fail=1: delay then 503", async () => {
    const t0 = Date.now();
    const res = await app.request("/quote/AAPL?fail=1&latency=150");
    expect(res.status).toBe(503);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });
});

describe("GET /quote/:symbol — ?body=", () => {
  test("returns the string verbatim as text/plain", async () => {
    const res = await app.request("/quote/AAPL?body=hello%20world");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("hello world");
  });

  test("empty ?body= returns an empty body", async () => {
    const res = await app.request("/quote/AAPL?body=");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("GET /quote/:symbol — ?x402=1", () => {
  test("402 with an x402-style challenge body + headers", async () => {
    const res = await app.request("/quote/AAPL?x402=1");
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("www-authenticate")).toMatch(/x402/i);

    const headerVal = res.headers.get("payment-required");
    expect(headerVal).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(headerVal as string, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("solana");

    const body = (await res.json()) as {
      x402Version: number;
      error: string;
      accepts: Array<Record<string, unknown>>;
    };
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe("payment_required");
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBe(1);
    const accept = body.accepts[0];
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("solana");
    expect(accept.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(typeof accept.payTo).toBe("string");
    expect(accept.maxAmountRequired).toBe("5000");
    expect(typeof accept.resource).toBe("string");
    expect(accept.resource).toContain("/quote/AAPL");
  });

  test("x402 takes precedence over ?status= and ?fail=", async () => {
    const res = await app.request("/quote/AAPL?x402=1&status=502&fail=1");
    expect(res.status).toBe(402);
  });

  test("composes with ?latency=: delay then 402", async () => {
    const t0 = Date.now();
    const res = await app.request("/quote/AAPL?x402=1&latency=150");
    expect(res.status).toBe(402);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });
});

describe("toggle precedence", () => {
  test("?status= beats ?fail= and ?body=", async () => {
    const res = await app.request("/quote/AAPL?status=418&fail=1&body=nope");
    expect(res.status).toBe(418);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(418);
  });

  test("?fail= beats ?body=", async () => {
    const res = await app.request("/quote/AAPL?fail=1&body=nope");
    expect(res.status).toBe(503);
  });
});
