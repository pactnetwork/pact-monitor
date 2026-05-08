import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { signedRequest, buildSignaturePayload } from "../src/lib/transport.ts";

describe("transport", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;
  let lastHeaders: Record<string, string> = {};

  beforeEach(() => {
    lastHeaders = {};
    const app = new Hono();
    app.all("/v1/helius/*", async (c) => {
      lastHeaders = Object.fromEntries(c.req.raw.headers.entries());
      const path = c.req.path;
      if (path.includes("/4xx")) return c.text("bad request", 400);
      if (path.includes("/with-call-id")) {
        return c.json({ ok: true }, 200, { "x-pact-call-id": "server-call-1234" });
      }
      return c.json({ ok: true });
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => server.stop());

  test("buildSignaturePayload formats correctly", () => {
    const sig = buildSignaturePayload({
      method: "GET",
      path: "/v1/helius/v0/balances",
      timestampMs: 1730800000000,
      nonce: "abc123",
      bodyHash: "deadbeef",
    });
    expect(sig).toBe("v1\nGET\n/v1/helius/v0/balances\n1730800000000\nabc123\ndeadbeef");
  });

  test("signedRequest sends X-Pact-* headers", async () => {
    const kp = Keypair.generate();
    const res = await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/v0/balances",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "test-proj",
    });
    expect(res.status).toBe(200);
    expect(lastHeaders["x-pact-agent"]).toBe(kp.publicKey.toBase58());
    expect(lastHeaders["x-pact-timestamp"]).toBeDefined();
    expect(lastHeaders["x-pact-nonce"]).toBeDefined();
    expect(lastHeaders["x-pact-signature"]).toBeDefined();
    expect(lastHeaders["x-pact-project"]).toBe("test-proj");
  });

  test("signedRequest signature verifies", async () => {
    const kp = Keypair.generate();
    await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/v0/balances",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
    });
    const ts = lastHeaders["x-pact-timestamp"];
    const nonce = lastHeaders["x-pact-nonce"];
    const sig = lastHeaders["x-pact-signature"];
    const payload = buildSignaturePayload({
      method: "GET",
      path: "/v1/helius/v0/balances",
      timestampMs: parseInt(ts),
      nonce,
      bodyHash: "",
    });
    const valid = nacl.sign.detached.verify(
      new TextEncoder().encode(payload),
      bs58.decode(sig),
      kp.publicKey.toBytes(),
    );
    expect(valid).toBe(true);
  });

  test("signedRequest returns response status for 4xx (no retry)", async () => {
    const kp = Keypair.generate();
    const res = await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/4xx",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
    });
    expect(res.status).toBe(400);
    expect(res.attempts).toBe(1);
  });

  test("defaults Accept-Encoding to identity-only when caller did not set one", async () => {
    // Regression: the market gateway buffers/decodes upstream bodies but
    // re-emits the upstream's Content-Encoding header. Any non-identity
    // Accept-Encoding here causes Bun's fetch to ZlibError on the response.
    const kp = Keypair.generate();
    await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/v0/balances",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
    });
    expect(lastHeaders["accept-encoding"]).toBe("identity;q=1, *;q=0");
    // No compression codings advertised — RFC 9110 §12.5.3.
    expect(lastHeaders["accept-encoding"]).not.toContain("gzip");
    expect(lastHeaders["accept-encoding"]).not.toContain("br");
    expect(lastHeaders["accept-encoding"]).not.toContain("deflate");
  });

  test("user-supplied Accept-Encoding overrides the gzip default", async () => {
    const kp = Keypair.generate();
    await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/v0/balances",
      method: "GET",
      headers: { "accept-encoding": "identity" },
      keypair: kp,
      project: "x",
    });
    expect(lastHeaders["accept-encoding"]).toBe("identity");
  });

  test("strips user-supplied authorization headers", async () => {
    const kp = Keypair.generate();
    await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/v0/balances",
      method: "GET",
      headers: { "x-api-key": "user-secret", authorization: "Bearer foo" },
      keypair: kp,
      project: "x",
    });
    expect(lastHeaders["x-api-key"]).toBeUndefined();
    expect(lastHeaders["authorization"]).toBeUndefined();
  });

  // Fix 3: callId from proxy response header
  test("signedRequest extracts x-pact-call-id from response header", async () => {
    const kp = Keypair.generate();
    const res = await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/with-call-id",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
    });
    expect(res.callId).toBe("server-call-1234");
  });

  test("signedRequest sets callId to null when header absent", async () => {
    const kp = Keypair.generate();
    const res = await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/v0/balances",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
    });
    expect(res.callId).toBeNull();
  });
});

// Regression: simulate the broken-gateway response path. The real market
// gateway buffers upstream bodies (Bun auto-decompresses) but forwards the
// upstream's Content-Encoding header alongside the now-plaintext body.
// Bun's fetch on this side will ZlibError unless the request advertised an
// Accept-Encoding the upstream would have answered with identity.
describe("transport: broken-gateway Content-Encoding mismatch", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    const app = new Hono();
    app.all("/v1/birdeye/*", (c) => {
      const accept = (c.req.header("accept-encoding") ?? "").toLowerCase();
      // Mimic the real bug: only attach a stale Content-Encoding when the
      // client claimed to accept compression. With strict identity, the
      // upstream would have skipped compression entirely so the gateway
      // has nothing stale to forward.
      const acceptsCompression =
        accept.includes("gzip") ||
        accept.includes("br") ||
        accept.includes("deflate");
      if (acceptsCompression) {
        return new Response('{"ok":true}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => server.stop());

  test("default Accept-Encoding survives broken gateway", async () => {
    const kp = Keypair.generate();
    const res = await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "birdeye",
      upstreamPath: "/defi/price",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test("user-supplied gzip Accept-Encoding hits ZlibError (proves we need identity default)", async () => {
    const kp = Keypair.generate();
    let threw: unknown = null;
    try {
      await signedRequest({
        gatewayUrl: `http://localhost:${port}`,
        slug: "birdeye",
        upstreamPath: "/defi/price",
        method: "GET",
        headers: { "accept-encoding": "gzip" },
        keypair: kp,
        project: "x",
        maxRetries: 0,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(String((threw as Error).message)).toMatch(/ZlibError/i);
  });
});

// Fix 5: 5xx retry test (uses its own server with a per-test counter)
describe("transport: 5xx retry", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    let callCount = 0;
    const app = new Hono();
    app.all("/v1/helius/fail-once", () => {
      callCount++;
      if (callCount === 1) {
        return new Response("server error", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, retried: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => server.stop());

  test("retries on 500 and returns 200 on second attempt", async () => {
    const kp = Keypair.generate();
    const res = await signedRequest({
      gatewayUrl: `http://localhost:${port}`,
      slug: "helius",
      upstreamPath: "/fail-once",
      method: "GET",
      headers: {},
      keypair: kp,
      project: "x",
      maxRetries: 2,
    });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(2);
  });
});
