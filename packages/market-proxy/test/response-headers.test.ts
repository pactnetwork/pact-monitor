// Alan review M2: outbound proxy responses must strip upstream-leak
// headers (Set-Cookie / Server / X-Powered-By / Access-Control-* / Via)
// and apply the proxy's own permissive CORS policy.

import { describe, test, expect } from "vitest";
import {
  sanitiseUpstreamResponseHeaders,
  buildSanitisedResponse,
} from "../src/lib/response-headers.js";

describe("sanitiseUpstreamResponseHeaders (Alan review M2)", () => {
  test("strips Set-Cookie", () => {
    const upstream = new Headers({
      "Set-Cookie": "session=abc; HttpOnly",
      "Content-Type": "application/json",
    });
    const out = sanitiseUpstreamResponseHeaders(upstream);
    expect(out.get("set-cookie")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
  });

  test("strips Server header", () => {
    const upstream = new Headers({
      Server: "cloudflare",
      "Content-Type": "application/json",
    });
    const out = sanitiseUpstreamResponseHeaders(upstream);
    expect(out.get("server")).toBeNull();
  });

  test("strips X-Powered-By, Via, X-AspNet-Version", () => {
    const upstream = new Headers({
      "X-Powered-By": "Express",
      Via: "1.1 vegur",
      "X-AspNet-Version": "4.0.30319",
    });
    const out = sanitiseUpstreamResponseHeaders(upstream);
    expect(out.get("x-powered-by")).toBeNull();
    expect(out.get("via")).toBeNull();
    expect(out.get("x-aspnet-version")).toBeNull();
  });

  test("strips upstream Access-Control-* and applies proxy CORS policy", () => {
    const upstream = new Headers({
      "Access-Control-Allow-Origin": "https://attacker.example.com",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Expose-Headers": "X-Internal",
    });
    const out = sanitiseUpstreamResponseHeaders(upstream);
    expect(out.get("access-control-allow-origin")).toBe("*");
    expect(out.get("access-control-allow-credentials")).toBeNull();
    expect(out.get("access-control-allow-methods")).toBeNull();
    expect(out.get("access-control-expose-headers")).toBeNull();
  });

  test("can opt out of CORS rewrite", () => {
    const upstream = new Headers({ "Content-Type": "application/json" });
    const out = sanitiseUpstreamResponseHeaders(upstream, { applyCors: false });
    expect(out.get("access-control-allow-origin")).toBeNull();
  });
});

describe("buildSanitisedResponse (Alan review M2)", () => {
  test("preserves caller-supplied X-Pact-* on top of stripped upstream", () => {
    const upstream = new Response("{}", {
      status: 200,
      headers: {
        "Set-Cookie": "session=leak",
        Server: "cloudflare",
        "Content-Type": "application/json",
      },
    });
    const pactHeaders = new Headers({
      "X-Pact-Outcome": "ok",
      "X-Pact-Premium": "500",
      "X-Pact-Refund": "0",
      "X-Pact-Latency-Ms": "120",
      "X-Pact-Call-Id": "abc",
    });
    const resp = buildSanitisedResponse(upstream, pactHeaders);

    expect(resp.headers.get("set-cookie")).toBeNull();
    expect(resp.headers.get("server")).toBeNull();
    expect(resp.headers.get("x-pact-outcome")).toBe("ok");
    expect(resp.headers.get("x-pact-premium")).toBe("500");
    expect(resp.headers.get("x-pact-call-id")).toBe("abc");
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(resp.status).toBe(200);
  });

  test("forwards body and status untouched", async () => {
    const upstream = new Response("hello", { status: 418 });
    const resp = buildSanitisedResponse(upstream);
    expect(resp.status).toBe(418);
    expect(await resp.text()).toBe("hello");
  });
});
