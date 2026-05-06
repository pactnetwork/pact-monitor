// Alan review M1: caller-supplied headers must be filtered through an
// explicit per-endpoint allowlist before they hit the upstream API.
//
// We exercise each endpoint's `buildRequest` and assert:
//   - Caller `Authorization` is NEVER forwarded (any endpoint).
//   - Caller `Cookie` is NEVER forwarded (any endpoint).
//   - Caller `X-API-KEY` IS forwarded for Birdeye, NOT for Helius / others.
//   - Common headers (Content-Type, Accept, Accept-Encoding) DO forward.
//   - `host` is dropped (existing behaviour).

import { describe, test, expect } from "vitest";
import { heliusHandler } from "../src/endpoints/helius.js";
import { birdeyeHandler } from "../src/endpoints/birdeye.js";
import { jupiterHandler } from "../src/endpoints/jupiter.js";
import { elfaHandler } from "../src/endpoints/elfa.js";
import { falHandler } from "../src/endpoints/fal.js";
import { buildUpstreamHeaders } from "../src/endpoints/headers.js";

const UPSTREAM_BASE = "https://upstream.example.com";

function makeIncoming(headers: Record<string, string>): Request {
  return new Request("https://proxy.example.com/v1/something/path?pact_wallet=w", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
    duplex: "half",
  } as RequestInit & { duplex: string });
}

describe("upstream header allowlist (Alan review M1)", () => {
  test("buildUpstreamHeaders forwards base allowlist and drops everything else", () => {
    const incoming = new Headers({
      "content-type": "application/json",
      accept: "*/*",
      "accept-encoding": "gzip",
      "user-agent": "agent/1.0",
      authorization: "Bearer caller-token",
      cookie: "session=abc",
      "x-forwarded-for": "1.2.3.4",
      host: "proxy.example.com",
      "x-custom-untrusted": "leak-me",
    });
    const out = buildUpstreamHeaders(incoming);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("accept")).toBe("*/*");
    expect(out.get("accept-encoding")).toBe("gzip");
    expect(out.get("user-agent")).toBe("agent/1.0");
    expect(out.get("authorization")).toBeNull();
    expect(out.get("cookie")).toBeNull();
    expect(out.get("x-forwarded-for")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("x-custom-untrusted")).toBeNull();
  });

  test("buildUpstreamHeaders never forwards Authorization even if listed in extraAllowed", () => {
    const incoming = new Headers({ authorization: "Bearer leak" });
    const out = buildUpstreamHeaders(incoming, new Set(["authorization"]));
    expect(out.get("authorization")).toBeNull();
  });

  test("Helius: caller Authorization is NOT forwarded", async () => {
    const req = makeIncoming({
      "Content-Type": "application/json",
      Authorization: "Bearer caller-secret",
    });
    const upstream = await heliusHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.headers.get("content-type")).toBe("application/json");
  });

  test("Helius: caller X-API-KEY is NOT forwarded (Helius auth is via query string)", async () => {
    const req = makeIncoming({ "X-API-KEY": "caller-helius-key" });
    const upstream = await heliusHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("x-api-key")).toBeNull();
  });

  test("Helius: caller Cookie is NOT forwarded", async () => {
    const req = makeIncoming({ Cookie: "session=secret" });
    const upstream = await heliusHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("cookie")).toBeNull();
  });

  test("Birdeye: caller X-API-KEY IS forwarded (intentional passthrough)", async () => {
    const req = makeIncoming({ "X-API-KEY": "caller-birdeye-key" });
    const upstream = await birdeyeHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("x-api-key")).toBe("caller-birdeye-key");
  });

  test("Birdeye: caller Authorization is NOT forwarded", async () => {
    const req = makeIncoming({ Authorization: "Bearer caller-secret" });
    const upstream = await birdeyeHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("authorization")).toBeNull();
  });

  test("Jupiter: caller Authorization is NOT forwarded", async () => {
    const req = makeIncoming({ Authorization: "Bearer caller-secret" });
    const upstream = await jupiterHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("authorization")).toBeNull();
  });

  test("Jupiter: caller X-API-KEY is NOT forwarded", async () => {
    const req = makeIncoming({ "X-API-KEY": "caller-key" });
    const upstream = await jupiterHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("x-api-key")).toBeNull();
  });

  test("Elfa: caller Authorization is NOT forwarded", async () => {
    const req = makeIncoming({ Authorization: "Bearer caller-secret" });
    const upstream = await elfaHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("authorization")).toBeNull();
  });

  test("fal: caller Authorization is NOT forwarded", async () => {
    const req = makeIncoming({ Authorization: "Bearer caller-secret" });
    const upstream = await falHandler.buildRequest(req, UPSTREAM_BASE);
    expect(upstream.headers.get("authorization")).toBeNull();
  });

  test("all endpoints drop the caller `host` header", async () => {
    const req = makeIncoming({
      Host: "evil.example.com",
      "Content-Type": "application/json",
    });
    for (const h of [heliusHandler, birdeyeHandler, jupiterHandler, elfaHandler, falHandler]) {
      const upstream = await h.buildRequest(req, UPSTREAM_BASE);
      expect(upstream.headers.get("host")).toBeNull();
    }
  });
});
