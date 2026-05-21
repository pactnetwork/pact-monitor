// Tests for the proxy merchant identity loader (D.1).
// Asserts env handling + happy-path key derivation + verifiable round-trip
// against the signProxiedBy/verifyProxiedBy helpers exposed by the SDK.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  signProxiedBy,
  verifyProxiedBy,
} from "@q3labs/pact-sdk/merchant";
import {
  getProxyMerchantIdentity,
  __resetProxyMerchantIdentityForTests,
} from "../lib/merchant-identity.js";

const originalEnv = process.env.PACT_PROXY_MERCHANT_SECRET_KEY;

beforeEach(() => {
  __resetProxyMerchantIdentityForTests();
});
afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.PACT_PROXY_MERCHANT_SECRET_KEY;
  } else {
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = originalEnv;
  }
  __resetProxyMerchantIdentityForTests();
});

describe("getProxyMerchantIdentity", () => {
  it("returns null when env is unset", () => {
    delete process.env.PACT_PROXY_MERCHANT_SECRET_KEY;
    expect(getProxyMerchantIdentity()).toBeNull();
  });

  it("accepts a base58-encoded 64-byte secret key", () => {
    const kp = nacl.sign.keyPair();
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = bs58.encode(kp.secretKey);
    const id = getProxyMerchantIdentity();
    expect(id).not.toBeNull();
    expect(id!.publicKeyB58).toBe(bs58.encode(kp.publicKey));
    expect(id!.secretKey.length).toBe(64);
  });

  it("accepts a JSON array (solana-keygen output)", () => {
    const kp = nacl.sign.keyPair();
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = JSON.stringify(
      Array.from(kp.secretKey),
    );
    const id = getProxyMerchantIdentity();
    expect(id).not.toBeNull();
    expect(id!.publicKeyB58).toBe(bs58.encode(kp.publicKey));
  });

  it("returns null on malformed input (not 64 bytes)", () => {
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = bs58.encode(Buffer.alloc(32, 0));
    expect(getProxyMerchantIdentity()).toBeNull();
  });

  it("returns null on garbage input", () => {
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = "not-valid-base58-O0Il$$$";
    expect(getProxyMerchantIdentity()).toBeNull();
  });

  it("caches across calls", () => {
    const kp = nacl.sign.keyPair();
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = bs58.encode(kp.secretKey);
    const first = getProxyMerchantIdentity();
    const second = getProxyMerchantIdentity();
    expect(first).toBe(second);
  });

  it("signs an attestation that verifies via the SDK helper", () => {
    const kp = nacl.sign.keyPair();
    process.env.PACT_PROXY_MERCHANT_SECRET_KEY = bs58.encode(kp.secretKey);
    const id = getProxyMerchantIdentity();
    expect(id).not.toBeNull();
    const agentPubkey = bs58.encode(nacl.sign.keyPair().publicKey);
    const msg = {
      merchantPubkey: id!.publicKeyB58,
      agentPubkey,
      startedAt: 1_717_000_000_000,
      endpoint: "helius",
      statusCode: 200,
    };
    const sig = signProxiedBy(msg, id!.secretKey);
    expect(verifyProxiedBy(msg, sig, id!.publicKeyB58)).toBe(true);
    // Tampering breaks the sig.
    expect(
      verifyProxiedBy({ ...msg, statusCode: 500 }, sig, id!.publicKeyB58),
    ).toBe(false);
  });
});
