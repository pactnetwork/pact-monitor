// C8: agent SDK outbound x-pact-pubkey + x-pact-started-at on every
// proxied request, and on the bare-fetch degrade path too. Lets merchant
// middleware attribute the call regardless of which path the SDK takes.

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildAuthHeaders } from "../proxy-transport.js";

describe("buildAuthHeaders (C8)", () => {
  it("includes x-pact-pubkey and x-pact-started-at alongside the wrap auth set", async () => {
    const kp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(kp.publicKey);
    const headers = await buildAuthHeaders({
      method: "POST",
      proxiedUrl: "https://market.example/v1/foo/bar?x=1",
      bodyBytes: new TextEncoder().encode('{"k":"v"}'),
      agentPubkey,
      secretKey: kp.secretKey,
      project: "test-project",
      now: () => 1_717_000_000_000,
    });
    expect(headers["x-pact-agent"]).toBe(agentPubkey);
    expect(headers["x-pact-pubkey"]).toBe(agentPubkey);
    expect(headers["x-pact-started-at"]).toBe("1717000000000");
    // The legacy auth set still rides.
    expect(headers["x-pact-timestamp"]).toBe("1717000000000");
    expect(typeof headers["x-pact-signature"]).toBe("string");
    expect(headers["x-pact-project"]).toBe("test-project");
  });

  it("uses the same timestamp for x-pact-timestamp and x-pact-started-at so the merchant attestation reconstruction matches", async () => {
    const kp = nacl.sign.keyPair();
    const agentPubkey = bs58.encode(kp.publicKey);
    const headers = await buildAuthHeaders({
      method: "GET",
      proxiedUrl: "https://market.example/v1/foo/bar",
      bodyBytes: null,
      agentPubkey,
      secretKey: kp.secretKey,
      project: "test-project",
      now: () => 1_717_111_111_111,
    });
    expect(headers["x-pact-started-at"]).toBe(headers["x-pact-timestamp"]);
  });
});
