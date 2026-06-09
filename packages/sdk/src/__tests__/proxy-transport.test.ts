import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import { getAddress, verifyMessage } from "viem";
import {
  buildSignaturePayload,
  buildProxiedUrl,
  buildAuthHeaders,
  cleanForwardHeaders,
  parsePactHeaders,
  isPactProcessed,
  bodyToBytes,
} from "../proxy-transport.js";
import type { SignFn } from "../signer.js";
import { sha256Hex } from "../crypto.js";

describe("buildSignaturePayload (v2)", () => {
  it("is byte-identical to the v2 market-proxy contract with NETWORK field", () => {
    const p = buildSignaturePayload({
      method: "post",
      path: "/v1/helius/v0/x?y=1",
      network: "base-sepolia",
      timestampMs: 1715990400000,
      nonce: "NONCE",
      bodyHash: "abcd",
    });
    expect(p).toBe(
      "v2\nPOST\n/v1/helius/v0/x?y=1\nbase-sepolia\n1715990400000\nNONCE\nabcd",
    );
  });

  it("embeds an empty NETWORK as literal '' when none is configured", () => {
    const p = buildSignaturePayload({
      method: "GET",
      path: "/v1/helius/x",
      network: "",
      timestampMs: 1,
      nonce: "N",
      bodyHash: "",
    });
    expect(p).toBe("v2\nGET\n/v1/helius/x\n\n1\nN\n");
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

describe("buildAuthHeaders — Solana path", () => {
  it("produces a v2 signature the proxy's Solana verify step accepts", async () => {
    const kp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(kp.publicKey);
    const proxiedUrl = "https://market.pactnetwork.io/v1/helius/v0/x?y=1";
    const bodyBytes = new TextEncoder().encode('{"a":1}');

    const sign: SignFn = async (payload) =>
      nacl.sign.detached(payload, kp.secretKey);

    const h = await buildAuthHeaders({
      method: "POST",
      proxiedUrl,
      bodyBytes,
      agentPubkey,
      sign,
      vm: "solana",
      project: "default",
      network: "solana-devnet",
      now: () => 1_700_000_000_000,
    });

    expect(h["x-pact-agent"]).toBe(agentPubkey);
    expect(h["x-pact-timestamp"]).toBe("1700000000000");
    expect(h["x-pact-project"]).toBe("default");
    expect(h["x-pact-network"]).toBe("solana-devnet");
    expect(h["x-pact-nonce"]).toBeTruthy();

    // Reconstruct the v2 payload and verify.
    const u = new URL(proxiedUrl);
    const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
    const payload = buildSignaturePayload({
      method: "POST",
      path: u.pathname + u.search,
      network: "solana-devnet",
      timestampMs: 1_700_000_000_000,
      nonce: h["x-pact-nonce"],
      bodyHash,
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(payload),
        bs58.decode(h["x-pact-signature"]),
        kp.publicKey,
      ),
    ).toBe(true);
  });

  it("uses an empty bodyHash and empty NETWORK for an empty body / no network", async () => {
    const kp = nacl.sign.keyPair();
    const proxiedUrl = "https://m.io/v1/dummy/q";
    const sign: SignFn = async (p) => nacl.sign.detached(p, kp.secretKey);
    const h = await buildAuthHeaders({
      method: "GET",
      proxiedUrl,
      bodyBytes: null,
      agentPubkey: bs58.encode(kp.publicKey),
      sign,
      vm: "solana",
      project: "p",
      now: () => 42,
    });
    expect(h["x-pact-network"]).toBeUndefined();
    const payload = buildSignaturePayload({
      method: "GET",
      path: "/v1/dummy/q",
      network: "",
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

describe("buildAuthHeaders — EVM path", () => {
  it("emits checksummed 0x agent + 0x-hex EIP-191 signature + x-pact-network", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const sign: SignFn = async (payload) =>
      account.signMessage({ message: { raw: payload } });

    const proxiedUrl = "https://market.pactnetwork.io/v1/helius-rpc/?api=1";
    const bodyBytes = new TextEncoder().encode('{"q":1}');

    const h = await buildAuthHeaders({
      method: "POST",
      proxiedUrl,
      bodyBytes,
      agentPubkey: getAddress(account.address),
      sign,
      vm: "evm",
      project: "default",
      network: "base-sepolia",
      now: () => 1_700_000_000_000,
    });

    // EIP-55 checksummed
    expect(h["x-pact-agent"]).toBe(getAddress(account.address));
    expect(h["x-pact-agent"]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // 0x + 130 hex chars (65 bytes secp256k1 r||s||v)
    expect(h["x-pact-signature"]).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(h["x-pact-network"]).toBe("base-sepolia");

    // Reconstruct v2 payload and verify with viem.
    const u = new URL(proxiedUrl);
    const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
    const payload = buildSignaturePayload({
      method: "POST",
      path: u.pathname + u.search,
      network: "base-sepolia",
      timestampMs: 1_700_000_000_000,
      nonce: h["x-pact-nonce"],
      bodyHash,
    });
    const ok = await verifyMessage({
      address: account.address,
      message: payload,
      signature: h["x-pact-signature"] as `0x${string}`,
    });
    expect(ok).toBe(true);
  });

  it("EVM sig does not verify when the network field differs (wrong-chain replay)", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const sign: SignFn = async (payload) =>
      account.signMessage({ message: { raw: payload } });

    const h = await buildAuthHeaders({
      method: "GET",
      proxiedUrl: "https://m.io/v1/helius/x",
      bodyBytes: null,
      agentPubkey: getAddress(account.address),
      sign,
      vm: "evm",
      project: "default",
      network: "base-sepolia",
      now: () => 42,
    });
    // Reconstruct with a DIFFERENT network — must fail.
    const evil = buildSignaturePayload({
      method: "GET",
      path: "/v1/helius/x",
      network: "arc-testnet",
      timestampMs: 42,
      nonce: h["x-pact-nonce"],
      bodyHash: "",
    });
    const ok = await verifyMessage({
      address: account.address,
      message: evil,
      signature: h["x-pact-signature"] as `0x${string}`,
    });
    expect(ok).toBe(false);
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

describe("sha256Hex (WebCrypto) byte-equivalence to node:crypto", () => {
  // The 401 guard: the proxy hashes raw wire bytes with node:crypto
  // (verify-signature.ts). The SDK now hashes with WebCrypto. ANY divergence
  // is a silent pact_auth_bad_sig. Pin equality over every body shape,
  // including a non-UTF-8 Uint8Array (the case a string-reencoding bug would
  // expose) and a view with a non-zero byteOffset.
  const big = new Uint8Array(300);
  for (let i = 0; i < big.length; i++) big[i] = (i * 37) % 256;
  const sliceView = big.subarray(5, 200); // byteOffset != 0

  const cases: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["ascii", new TextEncoder().encode("hello world")],
    ["multibyte utf8", new TextEncoder().encode("héllo · 日本語 · 🦊")],
    ["raw non-utf8 bytes", new Uint8Array([0, 255, 128, 1, 254, 200, 0xfe])],
    ["offset view", sliceView],
  ];

  for (const [name, bytes] of cases) {
    it(`matches node:crypto for ${name}`, async () => {
      const expected = createHash("sha256").update(bytes).digest("hex");
      expect(await sha256Hex(bytes)).toBe(expected);
    });
  }

  it("buildAuthHeaders signs over the WebCrypto hash the proxy will recompute", async () => {
    const kp = nacl.sign.keyPair();
    const bodyBytes = new Uint8Array([0, 255, 7, 200]); // non-utf8
    const proxiedUrl = "https://m.io/v1/dummy/x?z=1";
    const sign: SignFn = async (p) => nacl.sign.detached(p, kp.secretKey);
    const h = await buildAuthHeaders({
      method: "POST",
      proxiedUrl,
      bodyBytes,
      agentPubkey: bs58.encode(kp.publicKey),
      sign,
      vm: "solana",
      project: "default",
      now: () => 1_700_000_000_000,
    });
    const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
    const payload = buildSignaturePayload({
      method: "POST",
      path: "/v1/dummy/x?z=1",
      network: "",
      timestampMs: 1_700_000_000_000,
      nonce: h["x-pact-nonce"],
      bodyHash,
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
