import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { goldenFetch, type GoldenFetchDeps } from "../golden-fetch.js";
import type { SlugResolver, SlugResolution } from "../slug-resolver.js";

const kp = nacl.sign.keyPair();
const AGENT = bs58.encode(kp.publicKey);
const PROXY = "https://market.pactnetwork.io";

function resolverReturning(res: SlugResolution): SlugResolver {
  return { resolve: async () => res } as unknown as SlugResolver;
}

interface Captured {
  url: string;
  init?: RequestInit;
}

function deps(
  over: Partial<GoldenFetchDeps>,
  fetchImpl: typeof fetch,
): GoldenFetchDeps {
  return {
    resolver: resolverReturning({
      ok: true,
      entry: { slug: "helius", premiumBps: 100, paused: false },
    }),
    proxyBaseUrl: PROXY,
    project: "default",
    signRequests: true,
    agentPubkey: AGENT,
    secretKey: kp.secretKey,
    fetchImpl,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

function dispatcher(handlers: {
  proxy?: (u: string, i?: RequestInit) => Response | Promise<Response>;
  origin?: (u: string, i?: RequestInit) => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (u: string, i?: RequestInit) => {
    calls.push({ url: String(u), init: i });
    if (String(u).startsWith(`${PROXY}/v1/`)) {
      if (!handlers.proxy) throw new Error("unexpected proxy call");
      return handlers.proxy(String(u), i);
    }
    if (!handlers.origin) throw new Error("unexpected origin call");
    return handlers.origin(String(u), i);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("goldenFetch — degraded paths", () => {
  it("bare-fetches the original URL for an unregistered host", async () => {
    const { fetchImpl, calls } = dispatcher({
      origin: () => new Response("up", { status: 200 }),
    });
    const r = await goldenFetch(
      deps(
        { resolver: resolverReturning({ ok: false, reason: "unregistered", hostname: "x" }) },
        fetchImpl,
      ),
      "https://unknown.example.com/data",
      undefined,
    );
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("unregistered");
    expect(r.callId).toBeNull();
    expect(await r.response.text()).toBe("up");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://unknown.example.com/data");
  });

  it("degrades a paused endpoint", async () => {
    const { fetchImpl } = dispatcher({
      origin: () => new Response("", { status: 200 }),
    });
    const r = await goldenFetch(
      deps(
        { resolver: resolverReturning({ ok: false, reason: "paused", hostname: "p" }) },
        fetchImpl,
      ),
      "https://paused.example.com/x",
      undefined,
    );
    expect(r.degradedReason).toBe("paused");
  });

  it("degrades to 'unsigned' when signing is disabled or unavailable", async () => {
    const { fetchImpl, calls } = dispatcher({
      origin: () => new Response("bare", { status: 200 }),
    });
    const off = await goldenFetch(
      deps({ signRequests: false }, fetchImpl),
      "https://api.helius.xyz/v0/x",
      undefined,
    );
    expect(off.degradedReason).toBe("unsigned");
    const noKey = await goldenFetch(
      deps({ secretKey: null }, fetchImpl),
      "https://api.helius.xyz/v0/x",
      undefined,
    );
    expect(noKey.degradedReason).toBe("unsigned");
    expect(calls.every((c) => !c.url.includes("/v1/"))).toBe(true);
  });

  it("propagates a genuine upstream error unchanged (golden rule)", async () => {
    const boom = new TypeError("getaddrinfo ENOTFOUND");
    const { fetchImpl } = dispatcher({
      origin: () => {
        throw boom;
      },
    });
    await expect(
      goldenFetch(
        deps(
          { resolver: resolverReturning({ ok: false, reason: "unregistered", hostname: "x" }) },
          fetchImpl,
        ),
        "https://dead.example.com/x",
        undefined,
      ),
    ).rejects.toBe(boom);
  });
});

describe("goldenFetch — covered path", () => {
  it("routes through the proxy with signed x-pact-* headers", async () => {
    const { fetchImpl, calls } = dispatcher({
      proxy: () =>
        new Response("ok", {
          status: 200,
          headers: { "X-Pact-Call-Id": "cid-1", "X-Pact-Outcome": "ok" },
        }),
    });
    const r = await goldenFetch(deps({}, fetchImpl), "https://api.helius.xyz/v0/x?y=1", {
      method: "POST",
      body: '{"q":1}',
    });
    expect(r.degraded).toBe(false);
    expect(r.callId).toBe("cid-1");
    expect(r.slug).toBe("helius");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROXY}/v1/helius/v0/x?y=1`);
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h["x-pact-agent"]).toBe(AGENT);
    expect(h["x-pact-signature"]).toBeTruthy();
    expect(h["x-pact-project"]).toBe("default");
  });

  it("returns an insured upstream 5xx unchanged when the proxy processed it", async () => {
    const { fetchImpl } = dispatcher({
      proxy: () =>
        new Response("upstream down", {
          status: 503,
          headers: {
            "X-Pact-Call-Id": "cid-2",
            "X-Pact-Outcome": "server_error",
            "X-Pact-Refund": "10000",
          },
        }),
    });
    const r = await goldenFetch(
      deps({}, fetchImpl),
      "https://api.helius.xyz/v0/x",
      undefined,
    );
    expect(r.degraded).toBe(false);
    expect(r.response.status).toBe(503);
    expect(r.pactHeaders?.outcome).toBe("server_error");
    expect(r.pactHeaders?.refundLamports).toBe(10000n);
  });

  it("falls back to bare when the proxy 5xxs without Pact annotations", async () => {
    const { fetchImpl, calls } = dispatcher({
      proxy: () => new Response("proxy boom", { status: 502 }),
      origin: () => new Response("real upstream", { status: 200 }),
    });
    const r = await goldenFetch(
      deps({}, fetchImpl),
      "https://api.helius.xyz/v0/x",
      undefined,
    );
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("proxy_error");
    expect(await r.response.text()).toBe("real upstream");
    expect(calls.map((c) => c.url)).toEqual([
      `${PROXY}/v1/helius/v0/x`,
      "https://api.helius.xyz/v0/x",
    ]);
  });

  it("falls back to bare on a proxy auth rejection (401, no annotations)", async () => {
    const { fetchImpl } = dispatcher({
      proxy: () =>
        new Response(JSON.stringify({ error: "pact_auth_bad_sig" }), {
          status: 401,
        }),
      origin: () => new Response("upstream", { status: 200 }),
    });
    const r = await goldenFetch(
      deps({}, fetchImpl),
      "https://api.helius.xyz/v0/x",
      undefined,
    );
    expect(r.degradedReason).toBe("proxy_auth_rejected");
    expect(r.degraded).toBe(true);
  });

  it("falls back to bare (never throws) when the proxy is unreachable", async () => {
    const { fetchImpl } = dispatcher({
      proxy: () => {
        throw new Error("ECONNREFUSED");
      },
      origin: () => new Response("upstream", { status: 200 }),
    });
    const r = await goldenFetch(
      deps({}, fetchImpl),
      "https://api.helius.xyz/v0/x",
      undefined,
    );
    expect(r.degradedReason).toBe("proxy_unreachable");
    expect(await r.response.text()).toBe("upstream");
  });
});
