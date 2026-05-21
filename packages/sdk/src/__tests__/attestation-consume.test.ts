// E3: golden-fetch consumes X-Pact-Proxied-By + Sig from the proxy
// response, verifies against the merchant registry, and surfaces an
// AttributionVerified payload (factory.ts then suppresses buffer.append +
// emits 'attributed'). Invalid sig or unknown merchant → no attribution
// → SDK records normally as a fallback.

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { goldenFetch, type GoldenFetchDeps } from "../golden-fetch.js";
import { signProxiedBy } from "../merchant/attestation.js";
import { MerchantRegistry } from "../merchant-registry.js";

function fakeResolver(
  slug = "slug-x",
  paused = false,
): GoldenFetchDeps["resolver"] {
  return {
    async resolve() {
      if (paused) return { ok: false, reason: "paused", hostname: "api.test.local" };
      return { ok: true, entry: { slug, premiumBps: 100, paused: false } };
    },
    invalidate() {},
  } as unknown as GoldenFetchDeps["resolver"];
}

function fakeMerchantRegistry(
  known: Set<string>,
  hostnames: Record<string, string[]> = {},
): MerchantRegistry {
  return {
    hasMerchant: (pk: string) => known.has(pk),
    getMerchantHostnames: (pk: string) => hostnames[pk],
    start: async () => {},
    stop: () => {},
    refresh: async () => true,
  } as unknown as MerchantRegistry;
}

function fakeProxyFetch(
  pactHeaders: Record<string, string>,
  status = 200,
): typeof fetch {
  return (async () => {
    const h = new Headers();
    for (const [k, v] of Object.entries(pactHeaders)) h.set(k, v);
    return new Response("{}", { status, headers: h });
  }) as unknown as typeof fetch;
}

describe("E3 — golden-fetch attestation consumption", () => {
  it("returns attribution when proxied-by is signed by a known merchant and verifies", async () => {
    const merchantKp = nacl.sign.keyPair();
    const merchantPubkey = bs58.encode(merchantKp.publicKey);
    const agentKp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(agentKp.publicKey);

    const startedAt = 1_717_000_000_000;
    const sig = signProxiedBy(
      {
        merchantPubkey,
        agentPubkey,
        startedAt,
        endpoint: "slug-x",
        statusCode: 200,
      },
      merchantKp.secretKey,
    );

    const deps: GoldenFetchDeps = {
      resolver: fakeResolver(),
      merchantRegistry: fakeMerchantRegistry(
        new Set([merchantPubkey]),
        { [merchantPubkey]: ["api.test.local"] },
      ),
      proxyBaseUrl: "https://market.example",
      project: "test",
      signRequests: true,
      agentPubkey,
      secretKey: agentKp.secretKey,
      fetchImpl: fakeProxyFetch({
        "X-Pact-Call-Id": "call-1",
        "X-Pact-Outcome": "ok",
        "X-Pact-Proxied-By": merchantPubkey,
        "X-Pact-Proxied-Sig": sig,
      }),
      now: () => startedAt,
    };

    const res = await goldenFetch(deps, "https://api.test.local/v1/foo");
    expect(res.degraded).toBe(false);
    expect(res.attribution).not.toBeNull();
    expect(res.attribution!.merchantPubkey).toBe(merchantPubkey);
    expect(res.attribution!.startedAt).toBe(startedAt);
  });

  it("returns attribution=null when the merchant pubkey is unknown (record-normally fallback)", async () => {
    const merchantKp = nacl.sign.keyPair();
    const merchantPubkey = bs58.encode(merchantKp.publicKey);
    const agentKp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(agentKp.publicKey);

    const startedAt = 1_717_000_000_000;
    const sig = signProxiedBy(
      {
        merchantPubkey,
        agentPubkey,
        startedAt,
        endpoint: "slug-x",
        statusCode: 200,
      },
      merchantKp.secretKey,
    );

    const deps: GoldenFetchDeps = {
      resolver: fakeResolver(),
      // Empty registry — pubkey is unknown.
      merchantRegistry: fakeMerchantRegistry(new Set()),
      proxyBaseUrl: "https://market.example",
      project: "test",
      signRequests: true,
      agentPubkey,
      secretKey: agentKp.secretKey,
      fetchImpl: fakeProxyFetch({
        "X-Pact-Call-Id": "call-1",
        "X-Pact-Outcome": "ok",
        "X-Pact-Proxied-By": merchantPubkey,
        "X-Pact-Proxied-Sig": sig,
      }),
      now: () => startedAt,
    };

    const res = await goldenFetch(deps, "https://api.test.local/v1/foo");
    expect(res.attribution).toBeNull();
  });

  it("returns attribution=null when the signature does not verify", async () => {
    const merchantKp = nacl.sign.keyPair();
    const merchantPubkey = bs58.encode(merchantKp.publicKey);
    const agentKp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(agentKp.publicKey);

    // Sign with the merchant key but for a DIFFERENT startedAt — verify
    // against the actual startedAt will fail.
    const sig = signProxiedBy(
      {
        merchantPubkey,
        agentPubkey,
        startedAt: 999_999_999_999, // bogus
        endpoint: "slug-x",
        statusCode: 200,
      },
      merchantKp.secretKey,
    );

    const startedAt = 1_717_000_000_000;
    const deps: GoldenFetchDeps = {
      resolver: fakeResolver(),
      merchantRegistry: fakeMerchantRegistry(
        new Set([merchantPubkey]),
        { [merchantPubkey]: ["api.test.local"] },
      ),
      proxyBaseUrl: "https://market.example",
      project: "test",
      signRequests: true,
      agentPubkey,
      secretKey: agentKp.secretKey,
      fetchImpl: fakeProxyFetch({
        "X-Pact-Call-Id": "call-1",
        "X-Pact-Outcome": "ok",
        "X-Pact-Proxied-By": merchantPubkey,
        "X-Pact-Proxied-Sig": sig,
      }),
      now: () => startedAt,
    };

    const res = await goldenFetch(deps, "https://api.test.local/v1/foo");
    expect(res.attribution).toBeNull();
  });

  it("returns attribution=null when no proxied-by header is present", async () => {
    const agentKp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(agentKp.publicKey);

    const deps: GoldenFetchDeps = {
      resolver: fakeResolver(),
      merchantRegistry: fakeMerchantRegistry(
        new Set(["pk-doesnt-matter"]),
        { "pk-doesnt-matter": ["api.test.local"] },
      ),
      proxyBaseUrl: "https://market.example",
      project: "test",
      signRequests: true,
      agentPubkey,
      secretKey: agentKp.secretKey,
      fetchImpl: fakeProxyFetch({
        "X-Pact-Call-Id": "call-1",
        "X-Pact-Outcome": "ok",
      }),
    };

    const res = await goldenFetch(deps, "https://api.test.local/v1/foo");
    expect(res.attribution).toBeNull();
  });

  // PR #223 Section B: attestation must be bound to the merchant's
  // registered hostnames. A known pubkey signing for a host it doesn't
  // own gets treated as no attestation.
  it("returns attribution=null when the host is not in the merchant's registered hostnames", async () => {
    const merchantKp = nacl.sign.keyPair();
    const merchantPubkey = bs58.encode(merchantKp.publicKey);
    const agentKp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(agentKp.publicKey);

    const startedAt = 1_717_000_000_000;
    const sig = signProxiedBy(
      {
        merchantPubkey,
        agentPubkey,
        startedAt,
        endpoint: "slug-x",
        statusCode: 200,
      },
      merchantKp.secretKey,
    );

    const deps: GoldenFetchDeps = {
      resolver: fakeResolver(),
      merchantRegistry: fakeMerchantRegistry(
        new Set([merchantPubkey]),
        // Merchant is registered, but ONLY for api.OTHER.local — not for
        // api.test.local that the agent calls.
        { [merchantPubkey]: ["api.other.local"] },
      ),
      proxyBaseUrl: "https://market.example",
      project: "test",
      signRequests: true,
      agentPubkey,
      secretKey: agentKp.secretKey,
      fetchImpl: fakeProxyFetch({
        "X-Pact-Call-Id": "call-1",
        "X-Pact-Outcome": "ok",
        "X-Pact-Proxied-By": merchantPubkey,
        "X-Pact-Proxied-Sig": sig,
      }),
      now: () => startedAt,
    };

    const res = await goldenFetch(deps, "https://api.test.local/v1/foo");
    expect(res.attribution).toBeNull();
  });

  it("returns attribution=null when the merchant's registered hostname list is empty", async () => {
    const merchantKp = nacl.sign.keyPair();
    const merchantPubkey = bs58.encode(merchantKp.publicKey);
    const agentKp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(agentKp.publicKey);

    const startedAt = 1_717_000_000_000;
    const sig = signProxiedBy(
      {
        merchantPubkey,
        agentPubkey,
        startedAt,
        endpoint: "slug-x",
        statusCode: 200,
      },
      merchantKp.secretKey,
    );

    const deps: GoldenFetchDeps = {
      resolver: fakeResolver(),
      merchantRegistry: fakeMerchantRegistry(
        new Set([merchantPubkey]),
        { [merchantPubkey]: [] },
      ),
      proxyBaseUrl: "https://market.example",
      project: "test",
      signRequests: true,
      agentPubkey,
      secretKey: agentKp.secretKey,
      fetchImpl: fakeProxyFetch({
        "X-Pact-Call-Id": "call-1",
        "X-Pact-Outcome": "ok",
        "X-Pact-Proxied-By": merchantPubkey,
        "X-Pact-Proxied-Sig": sig,
      }),
      now: () => startedAt,
    };

    const res = await goldenFetch(deps, "https://api.test.local/v1/foo");
    expect(res.attribution).toBeNull();
  });
});
