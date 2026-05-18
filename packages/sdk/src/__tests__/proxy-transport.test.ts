import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  buildSignaturePayload,
  buildProxiedUrl,
  buildAuthHeaders,
  cleanForwardHeaders,
  parsePactHeaders,
  isPactProcessed,
  bodyToBytes,
} from "../proxy-transport.js";

describe("buildSignaturePayload", () => {
  it("is byte-identical to the market-proxy contract", () => {
    // Mirrors packages/market-proxy/src/middleware/verify-signature.ts
    const p = buildSignaturePayload({
      method: "post",
      path: "/v1/helius/v0/x?y=1",
      timestampMs: 1715990400000,
      nonce: "NONCE",
      bodyHash: "abcd",
    });
    expect(p).toBe("v1\nPOST\n/v1/helius/v0/x?y=1\n1715990400000\nNONCE\nabcd");
  });
});

describe("buildProxiedUrl", () => {
  it("rewrites to /v1/<slug>/<path> preserving query", () => {
    expect(
      buildProxiedUrl(
        "https://market.pactnetwork.io/",
        "helius",
        "https://api.helius.xyz/v0/addresses/foo?limit=2",
      ),
    ).toBe("https://market.pactnetwork.io/v1/helius/v0/addresses/foo?limit=2");
  });

  it("handles a root path", () => {
    expect(
      buildProxiedUrl("https://m.io", "dummy", "https://dummy.pactnetwork.io/"),
    ).toBe("https://m.io/v1/dummy/");
  });
});

describe("buildAuthHeaders", () => {
  it("produces a signature the proxy's verify step would accept", () => {
    const kp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(kp.publicKey);
    const proxiedUrl = "https://market.pactnetwork.io/v1/helius/v0/x?y=1";
    const bodyBytes = new TextEncoder().encode('{"a":1}');

    const h = buildAuthHeaders({
      method: "POST",
      proxiedUrl,
      bodyBytes,
      agentPubkey,
      secretKey: kp.secretKey,
      project: "default",
      now: () => 1_700_000_000_000,
    });

    expect(h["x-pact-agent"]).toBe(agentPubkey);
    expect(h["x-pact-timestamp"]).toBe("1700000000000");
    expect(h["x-pact-project"]).toBe("default");
    expect(h["x-pact-nonce"]).toBeTruthy();

    // Reconstruct exactly as verify-signature.ts does and verify.
    const u = new URL(proxiedUrl);
    const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
    const payload = buildSignaturePayload({
      method: "POST",
      path: u.pathname + u.search,
      timestampMs: 1_700_000_000_000,
      nonce: h["x-pact-nonce"],
      bodyHash,
    });
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(payload),
      bs58.decode(h["x-pact-signature"]),
      kp.publicKey,
    );
    expect(ok).toBe(true);
  });

  it("uses an empty bodyHash for an empty body", () => {
    const kp = nacl.sign.keyPair();
    const proxiedUrl = "https://m.io/v1/dummy/q";
    const h = buildAuthHeaders({
      method: "GET",
      proxiedUrl,
      bodyBytes: null,
      agentPubkey: bs58.encode(kp.publicKey),
      secretKey: kp.secretKey,
      project: "p",
      now: () => 42,
    });
    const payload = buildSignaturePayload({
      method: "GET",
      path: "/v1/dummy/q",
      timestampMs: 42,
      nonce: h["x-pact-nonce"],
      bodyHash: "",
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(payload),
        bs58.decode(h["x-pact-signature"]),
        kp.publicKey,
      ),
    ).toBe(true);
  });
});

describe("cleanForwardHeaders", () => {
  it("strips upstream auth and injects no-compression", () => {
    const out = cleanForwardHeaders({
      authorization: "Bearer secret",
      "x-api-key": "k",
      "content-type": "application/json",
    });
    expect(out.authorization).toBeUndefined();
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["content-type"]).toBe("application/json");
    expect(out["accept-encoding"]).toBe("identity;q=1, *;q=0");
  });

  it("respects a caller-set accept-encoding", () => {
    const out = cleanForwardHeaders({ "accept-encoding": "gzip" });
    expect(out["accept-encoding"]).toBe("gzip");
  });
});

describe("parsePactHeaders / isPactProcessed", () => {
  it("parses all X-Pact-* annotations", () => {
    const h = new Headers({
      "X-Pact-Call-Id": "cid",
      "X-Pact-Premium": "1000",
      "X-Pact-Refund": "250",
      "X-Pact-Latency-Ms": "143",
      "X-Pact-Outcome": "server_error",
      "X-Pact-Pool": "helius",
      "X-Pact-Settlement-Pending": "1",
    });
    const p = parsePactHeaders(h);
    expect(p.callId).toBe("cid");
    expect(p.premiumLamports).toBe(1000n);
    expect(p.refundLamports).toBe(250n);
    expect(p.latencyMs).toBe(143);
    expect(p.outcome).toBe("server_error");
    expect(p.pool).toBe("helius");
    expect(p.settlementPending).toBe(true);
    expect(isPactProcessed(p)).toBe(true);
  });

  it("flags an unannotated response as not Pact-processed", () => {
    expect(isPactProcessed(parsePactHeaders(new Headers()))).toBe(false);
  });
});

describe("bodyToBytes", () => {
  it("encodes strings, passes typed arrays, rejects streams", () => {
    expect(bodyToBytes("ab")).toEqual(new TextEncoder().encode("ab"));
    const u = new Uint8Array([1, 2, 3]);
    expect(bodyToBytes(u)).toBe(u);
    expect(bodyToBytes(null)).toBeNull();
    expect(bodyToBytes("")).toBeNull();
    expect(bodyToBytes(new ReadableStream())).toBeNull();
  });
});
