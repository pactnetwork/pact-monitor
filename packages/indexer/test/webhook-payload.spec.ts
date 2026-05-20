import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  buildWebhookCanonical,
  loadSigningKey,
  signWebhook,
  WEBHOOK_EVENT,
  type WebhookPayload,
} from "../src/refund-delivery/webhook-payload";

// Executable spec of the ONE webhook contract — the SDK receiver implements
// verification against exactly this.
describe("webhook signing contract", () => {
  const kp = nacl.sign.keyPair();
  const secretBs58 = bs58.encode(kp.secretKey);
  const url = "https://hooks.example.com/pact?x=1";
  const payload: WebhookPayload = {
    type: "settlement.calls",
    version: 1,
    indexerTs: "2026-05-18T00:00:00.000Z",
    agentPubkey: "AgEnT",
    calls: [
      {
        callId: "c1",
        agentPubkey: "AgEnT",
        endpointSlug: "dummy",
        premiumLamports: "100",
        refundLamports: "9000",
        breach: true,
        settledAt: "2026-05-18T00:00:06.000Z",
        signature: "BATCHSIG",
      },
    ],
  };

  it("loadSigningKey rejects a non-64-byte secret", () => {
    expect(() => loadSigningKey(bs58.encode(new Uint8Array(32)))).toThrow(
      /64-byte/,
    );
  });

  it("produces headers an independent verifier accepts", () => {
    const { publicKeyBase58, secretKey } = loadSigningKey(secretBs58);
    const { headers, body } = signWebhook({
      secretKey,
      publicKeyBase58,
      webhookUrl: url,
      payload,
      now: () => 1_700_000_000_000,
    });

    expect(headers["x-pact-event"]).toBe(WEBHOOK_EVENT);
    expect(headers["x-pact-agent"]).toBe(publicKeyBase58);
    expect(headers["x-pact-timestamp"]).toBe("1700000000000");

    // Reconstruct exactly as the SDK receiver will.
    const u = new URL(url);
    const bodyHash = createHash("sha256")
      .update(new TextEncoder().encode(body))
      .digest("hex");
    const canonical = buildWebhookCanonical({
      path: u.pathname + u.search,
      timestampMs: 1_700_000_000_000,
      nonce: headers["x-pact-nonce"],
      bodyHash,
    });
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      bs58.decode(headers["x-pact-signature"]),
      bs58.decode(headers["x-pact-agent"]),
    );
    expect(ok).toBe(true);

    // A tampered body must fail verification.
    const badHash = createHash("sha256").update("tampered").digest("hex");
    const badCanonical = buildWebhookCanonical({
      path: u.pathname + u.search,
      timestampMs: 1_700_000_000_000,
      nonce: headers["x-pact-nonce"],
      bodyHash: badHash,
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(badCanonical),
        bs58.decode(headers["x-pact-signature"]),
        bs58.decode(headers["x-pact-agent"]),
      ),
    ).toBe(false);
  });
});
