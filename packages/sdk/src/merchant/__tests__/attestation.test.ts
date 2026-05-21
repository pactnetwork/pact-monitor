import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createHash } from "node:crypto";
import {
  canonicalProxiedByMessage,
  signProxiedBy,
  verifyProxiedBy,
  PROXIED_BY_DOMAIN,
  type ProxiedByMessage,
} from "../attestation.js";

function freshKeypair(): { sk: Uint8Array; pkB58: string } {
  const pair = nacl.sign.keyPair();
  return { sk: pair.secretKey, pkB58: bs58.encode(pair.publicKey) };
}

const SAMPLE: ProxiedByMessage = {
  merchantPubkey: "11111111111111111111111111111111",
  agentPubkey: "22222222222222222222222222222222",
  startedAt: 1_717_000_000_000,
  endpoint: "/v1/generate-image",
  statusCode: 200,
};

describe("attestation", () => {
  it("round-trips sign and verify", () => {
    const { sk, pkB58 } = freshKeypair();
    const m = { ...SAMPLE, merchantPubkey: pkB58 };
    const sig = signProxiedBy(m, sk);
    expect(verifyProxiedBy(m, sig, pkB58)).toBe(true);
  });

  it("fails verify on tampered statusCode", () => {
    const { sk, pkB58 } = freshKeypair();
    const m = { ...SAMPLE, merchantPubkey: pkB58 };
    const sig = signProxiedBy(m, sk);
    expect(verifyProxiedBy({ ...m, statusCode: 500 }, sig, pkB58)).toBe(false);
  });

  it("fails verify on tampered startedAt", () => {
    const { sk, pkB58 } = freshKeypair();
    const m = { ...SAMPLE, merchantPubkey: pkB58 };
    const sig = signProxiedBy(m, sk);
    expect(verifyProxiedBy({ ...m, startedAt: m.startedAt + 1 }, sig, pkB58)).toBe(false);
  });

  it("fails verify against a different pubkey", () => {
    const { sk, pkB58 } = freshKeypair();
    const other = freshKeypair();
    const m = { ...SAMPLE, merchantPubkey: pkB58 };
    const sig = signProxiedBy(m, sk);
    expect(verifyProxiedBy(m, sig, other.pkB58)).toBe(false);
  });

  it("rejects a sig produced WITHOUT the domain prefix", () => {
    const { sk, pkB58 } = freshKeypair();
    const m = { ...SAMPLE, merchantPubkey: pkB58 };
    // Build a "domain-less" canonical message — identical to ours but
    // missing the PROXIED_BY_DOMAIN line.
    const text = [m.merchantPubkey, m.agentPubkey, String(m.startedAt), m.endpoint, String(m.statusCode)].join("\n");
    const digest = createHash("sha256").update(text, "utf8").digest();
    const sig = Buffer.from(nacl.sign.detached(digest, sk)).toString("base64");
    expect(verifyProxiedBy(m, sig, pkB58)).toBe(false);
  });

  it("returns false on malformed inputs", () => {
    expect(verifyProxiedBy(SAMPLE, "not-base64$$$", SAMPLE.merchantPubkey)).toBe(false);
    expect(verifyProxiedBy(SAMPLE, "", "not-base58-O0Il")).toBe(false);
    // Right-length-wrong-bytes sig
    const junkSig = Buffer.alloc(64, 0).toString("base64");
    expect(verifyProxiedBy(SAMPLE, junkSig, SAMPLE.merchantPubkey)).toBe(false);
  });

  it("canonical message is stable across calls", () => {
    const a = canonicalProxiedByMessage(SAMPLE);
    const b = canonicalProxiedByMessage(SAMPLE);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("PROXIED_BY_DOMAIN is the v1 marker", () => {
    expect(PROXIED_BY_DOMAIN).toBe("pact:proxied-by:v1");
  });
});
