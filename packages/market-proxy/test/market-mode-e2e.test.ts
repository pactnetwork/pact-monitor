// L2: market-mode end-to-end integration test.
//
// Agent SDK hits the Pact Market proxy at `${proxyBaseUrl}/v1/:slug/*`. The
// proxy invokes wrapFetch (charges premium, records via the EventSink) and
// — when PACT_PROXY_MERCHANT_SECRET_KEY is set — stamps X-Pact-Proxied-By
// + X-Pact-Proxied-Sig on the response so the agent SDK can attribute the
// call to the proxy as merchant-of-record (E3).
//
// Mocks env + context the same way test/proxy.test.ts does so the
// module-load env parse doesn't trip on missing PG_URL etc.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Hono } from "hono";
import { Keypair } from "@solana/web3.js";
import { MemoryEventSink } from "@pact-network/wrap";

vi.mock("../src/env.js", () => ({
  env: {
    PG_URL: "postgresql://localhost/test",
    RPC_URL: "http://localhost:8899",
    PROGRAM_ID: "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5",
    USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    PUBSUB_PROJECT: "test",
    PUBSUB_TOPIC: "pact-settle-events",
    ENDPOINTS_RELOAD_TOKEN: "test-token-1234567890",
    PORT: "8080",
    QUEUE_BACKEND: "pubsub",
  },
}));

type MockCtx = {
  registry: { get(s: string): Promise<unknown> };
  demoAllowlist: unknown;
  operatorAllowlist: unknown;
  balanceCheck: unknown;
  sink: MemoryEventSink;
  pg: unknown;
  betaGateFlag: unknown;
};

function emptyCtx(): MockCtx {
  return {
    registry: { async get() { return undefined; } },
    demoAllowlist: { async has() { return false; }, get size() { return 0; }, async reload() {} },
    operatorAllowlist: { async has() { return false; }, get size() { return 0; }, async reload() {} },
    balanceCheck: undefined,
    sink: new MemoryEventSink(),
    pg: undefined,
    betaGateFlag: { async isOn() { return false; } },
  };
}
let currentMockContext: MockCtx = emptyCtx();

vi.mock("../src/lib/context.js", () => ({
  getContext: () => currentMockContext,
  setContext: (ctx: MockCtx) => {
    currentMockContext = ctx;
  },
  initContext: vi.fn(),
}));

import { createPact } from "@q3labs/pact-sdk";
import { verifyProxiedBy } from "@q3labs/pact-sdk/merchant";
import { proxyRoute } from "../src/routes/proxy.js";
import { __resetProxyMerchantIdentityForTests } from "../src/lib/merchant-identity.js";

const originalSecret = process.env.PACT_PROXY_MERCHANT_SECRET_KEY;

beforeEach(() => {
  __resetProxyMerchantIdentityForTests();
  currentMockContext = emptyCtx();
});
afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.PACT_PROXY_MERCHANT_SECRET_KEY;
  } else {
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = originalSecret;
  }
  __resetProxyMerchantIdentityForTests();
});

async function startQuoteServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/quote/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

interface MockSlug {
  slug: string;
  hostname: string;
  upstreamBase: string;
}

function buildCtx(slug: MockSlug, sink: MemoryEventSink): MockCtx {
  return {
    registry: {
      async get(s: string) {
        if (s !== slug.slug) return undefined;
        return {
          slug: slug.slug,
          flatPremiumLamports: 100n,
          percentBps: 100,
          slaLatencyMs: 5_000,
          imputedCostLamports: 10_000n,
          exposureCapPerHourLamports: 1_000_000n,
          paused: false,
          upstreamBase: slug.upstreamBase,
          displayName: slug.slug,
        };
      },
    },
    demoAllowlist: { async has() { return false; }, get size() { return 0; }, async reload() {} },
    operatorAllowlist: { async has() { return false; }, get size() { return 0; }, async reload() {} },
    balanceCheck: undefined,
    sink,
    pg: undefined,
    betaGateFlag: { async isOn() { return false; } },
  };
}

describe("L2 market-mode E2E: proxy attestation + agent SDK verification", () => {
  it("agent sees the proxy's X-Pact-Proxied-By sig and emits 'attributed'", async () => {
    const proxyKp = nacl.sign.keyPair();
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = bs58.encode(proxyKp.secretKey);
    const proxyMerchantPubkey = bs58.encode(proxyKp.publicKey);

    const agentSigner = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
    const agentPubkey = agentSigner.publicKey.toBase58();

    const upstream = await startQuoteServer();
    const sink = new MemoryEventSink();
    const slug: MockSlug = {
      slug: "dummy",
      hostname: "known.test",
      upstreamBase: upstream.url,
    };
    currentMockContext = buildCtx(slug, sink);

    const proxyApp = new Hono();
    proxyApp.all("/v1/:slug/*", proxyRoute);
    proxyApp.get("/.well-known/endpoints", (c) =>
      c.json({
        cacheTtlSec: 60,
        endpoints: [
          { slug: slug.slug, hostnames: [slug.hostname], premiumBps: 100, paused: false },
        ],
      }),
    );

    const PROXY_BASE = "http://proxy.test";
    const dispatcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(PROXY_BASE)) {
        const rel = url.slice(PROXY_BASE.length);
        return proxyApp.fetch(new Request(`http://proxy${rel}`, init));
      }
      if (url.includes("/api/v1/merchants")) {
        return new Response(
          JSON.stringify({
            merchants: [
              {
                pubkey: proxyMerchantPubkey,
                label: "market-proxy",
                hostnames: [slug.hostname],
              },
            ],
            generatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { ETag: '"merchants-v1"' } },
        );
      }
      if (url.includes("/api/v1/records/peek")) {
        return new Response(JSON.stringify({ exists: true }), { status: 200 });
      }
      throw new Error(`unexpected dispatcher fetch: ${url}`);
    }) as unknown as typeof fetch;

    const memStorage = {
      appended: [] as unknown[],
      append(obs: unknown) { this.appended.push(obs); },
      loadPending() { return [] as never[]; },
      markReconciled() {},
    };

    const pact = await createPact({
      network: "localnet",
      signer: agentSigner,
      project: "test",
      proxyBaseUrl: PROXY_BASE,
      fetchImpl: dispatcher,
      storage: memStorage as never,
      installSignalHandlers: false,
      indexerPollIntervalMs: 60_000,
    });
    const attributed: unknown[] = [];
    pact.on("attributed", (e) => attributed.push(e));
    await new Promise((r) => setTimeout(r, 30));

    try {
      const res = await pact.fetch(`http://${slug.hostname}/quote/SOL`);
      expect(res.status).toBe(200);

      const proxiedBy = res.headers.get("x-pact-proxied-by");
      const proxiedSig = res.headers.get("x-pact-proxied-sig");
      expect(proxiedBy).toBe(proxyMerchantPubkey);
      expect(proxiedSig).toBeTruthy();

      await new Promise((r) => setTimeout(r, 30));

      expect(attributed.length).toBe(1);
      const ev = attributed[0] as { merchantPubkey: string; callId: string | null };
      expect(ev.merchantPubkey).toBe(proxyMerchantPubkey);
      expect(typeof ev.callId).toBe("string");

      expect(sink.events.length).toBe(1);
      expect(sink.events[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(sink.events[0].latencyMs).toBeLessThan(2_000);

      expect(memStorage.appended.length).toBe(0);

      // External verification: reconstruct the signed startedAt from the
      // settlement event's tEnd - latencyMs.
      const evt = sink.events[0];
      const reconstructedStartedAt = new Date(evt.ts).getTime() - evt.latencyMs;
      expect(
        verifyProxiedBy(
          {
            merchantPubkey: proxyMerchantPubkey,
            agentPubkey,
            startedAt: reconstructedStartedAt,
            endpoint: slug.slug,
            statusCode: 200,
          },
          proxiedSig!,
          proxyMerchantPubkey,
        ),
      ).toBe(true);
    } finally {
      await pact.shutdown();
      await upstream.close();
    }
  });

  it("when proxy env is unset, no attestation header is stamped and agent does NOT emit 'attributed'", async () => {
    delete process.env.PACT_PROXY_MERCHANT_SECRET_KEY;
    const agentSigner = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);

    const upstream = await startQuoteServer();
    const sink = new MemoryEventSink();
    const slug: MockSlug = {
      slug: "dummy",
      hostname: "known2.test",
      upstreamBase: upstream.url,
    };
    currentMockContext = buildCtx(slug, sink);

    const proxyApp = new Hono();
    proxyApp.all("/v1/:slug/*", proxyRoute);
    proxyApp.get("/.well-known/endpoints", (c) =>
      c.json({
        cacheTtlSec: 60,
        endpoints: [
          { slug: slug.slug, hostnames: [slug.hostname], premiumBps: 100, paused: false },
        ],
      }),
    );

    const PROXY_BASE = "http://proxy2.test";
    const dispatcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(PROXY_BASE)) {
        const rel = url.slice(PROXY_BASE.length);
        return proxyApp.fetch(new Request(`http://proxy${rel}`, init));
      }
      if (url.includes("/api/v1/merchants")) {
        return new Response(
          JSON.stringify({ merchants: [], generatedAt: new Date().toISOString() }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/records/peek")) {
        return new Response(JSON.stringify({ exists: true }), { status: 200 });
      }
      throw new Error(`unexpected dispatcher fetch: ${url}`);
    }) as unknown as typeof fetch;

    const memStorage = {
      appended: [] as unknown[],
      append(obs: unknown) { this.appended.push(obs); },
      loadPending() { return [] as never[]; },
      markReconciled() {},
    };

    const pact = await createPact({
      network: "localnet",
      signer: agentSigner,
      project: "test",
      proxyBaseUrl: PROXY_BASE,
      fetchImpl: dispatcher,
      storage: memStorage as never,
      installSignalHandlers: false,
      indexerPollIntervalMs: 60_000,
    });
    const attributed: unknown[] = [];
    pact.on("attributed", (e) => attributed.push(e));
    await new Promise((r) => setTimeout(r, 30));

    try {
      const res = await pact.fetch(`http://${slug.hostname}/quote/SOL`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-pact-proxied-by")).toBeNull();
      expect(res.headers.get("x-pact-proxied-sig")).toBeNull();

      await new Promise((r) => setTimeout(r, 30));
      expect(attributed.length).toBe(0);
      expect(memStorage.appended.length).toBe(1);
    } finally {
      await pact.shutdown();
      await upstream.close();
    }
  });
});
