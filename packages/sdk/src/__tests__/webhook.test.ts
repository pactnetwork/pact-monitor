/**
 * Webhook receiver verification + the webhook/poller hybrid dedupe (M1):
 * a call settled by one path is never re-emitted by the other.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { createPact } from "../factory.js";
import {
  createWebhookHandler,
  type SettlementNotification,
} from "../webhook.js";

// Sign exactly as the indexer's refund-delivery/webhook-payload.ts does.
function signLikeIndexer(args: {
  secretKey: Uint8Array;
  pub: string;
  path: string;
  ts: number;
  nonce: string;
  body: string;
}) {
  const bodyHash = createHash("sha256")
    .update(new TextEncoder().encode(args.body))
    .digest("hex");
  const canonical = `v1\nPOST\n${args.path}\n${args.ts}\n${args.nonce}\n${bodyHash}`;
  const sig = nacl.sign.detached(
    new TextEncoder().encode(canonical),
    args.secretKey,
  );
  return {
    "x-pact-event": "refund.settled",
    "x-pact-agent": args.pub,
    "x-pact-timestamp": String(args.ts),
    "x-pact-nonce": args.nonce,
    "x-pact-signature": bs58.encode(sig),
  };
}

const PATH = "/pact-webhook";
function payloadFor(callId: string): string {
  return JSON.stringify({
    type: "settlement.calls",
    version: 1,
    indexerTs: "2026-05-18T00:00:00.000Z",
    agentPubkey: "A",
    calls: [
      {
        callId,
        agentPubkey: "A",
        endpointSlug: "dummy",
        premiumLamports: "100",
        refundLamports: "9000",
        breach: true,
        settledAt: "2026-05-18T00:00:06.000Z",
        signature: "BATCHSIG",
      },
    ],
  });
}

describe("createWebhookHandler verification", () => {
  const idx = nacl.sign.keyPair();
  const pub = bs58.encode(idx.publicKey);
  let got: SettlementNotification[];
  const handler = createWebhookHandler({
    config: { indexerSigningKey: pub },
    reconcile: (n) => got.push(n),
  });
  beforeEach(() => {
    got = [];
  });

  function req(headers: Record<string, string>, body: string) {
    return { method: "POST", path: PATH, headers, body };
  }

  it("accepts a correctly signed payload and reconciles each call", async () => {
    const body = payloadFor("c1");
    const headers = signLikeIndexer({
      secretKey: idx.secretKey,
      pub,
      path: PATH,
      ts: Date.now(),
      nonce: bs58.encode(nacl.randomBytes(16)),
      body,
    });
    const res = await handler(req(headers, body));
    expect(res.status).toBe(202);
    expect(got).toHaveLength(1);
    expect(got[0].callId).toBe("c1");
    expect(got[0].refundLamports).toBe(9000n);
    expect(got[0].breach).toBe(true);
  });

  it("rejects a forged signature (401, no reconcile, no throw)", async () => {
    const body = payloadFor("c1");
    const headers = signLikeIndexer({
      secretKey: nacl.sign.keyPair().secretKey, // different signer
      pub,
      path: PATH,
      ts: Date.now(),
      nonce: bs58.encode(nacl.randomBytes(16)),
      body,
    });
    const res = await handler(req(headers, body));
    expect(res.status).toBe(401);
    expect(got).toHaveLength(0);
  });

  it("rejects a non-pinned signer key", async () => {
    const other = nacl.sign.keyPair();
    const body = payloadFor("c1");
    const headers = signLikeIndexer({
      secretKey: other.secretKey,
      pub: bs58.encode(other.publicKey),
      path: PATH,
      ts: Date.now(),
      nonce: bs58.encode(nacl.randomBytes(16)),
      body,
    });
    expect((await handler(req(headers, body))).status).toBe(401);
    expect(got).toHaveLength(0);
  });

  it("rejects a stale timestamp", async () => {
    const body = payloadFor("c1");
    const headers = signLikeIndexer({
      secretKey: idx.secretKey,
      pub,
      path: PATH,
      ts: Date.now() - 600_000,
      nonce: bs58.encode(nacl.randomBytes(16)),
      body,
    });
    expect((await handler(req(headers, body))).status).toBe(401);
  });

  it("rejects a replayed nonce", async () => {
    const body = payloadFor("c1");
    const nonce = bs58.encode(nacl.randomBytes(16));
    const headers = signLikeIndexer({
      secretKey: idx.secretKey,
      pub,
      path: PATH,
      ts: Date.now(),
      nonce,
      body,
    });
    expect((await handler(req(headers, body))).status).toBe(202);
    expect((await handler(req(headers, body))).status).toBe(401);
  });

  it("rejects malformed JSON after a valid signature (400, no throw)", async () => {
    const body = "{not json";
    const headers = signLikeIndexer({
      secretKey: idx.secretKey,
      pub,
      path: PATH,
      ts: Date.now(),
      nonce: bs58.encode(nacl.randomBytes(16)),
      body,
    });
    expect((await handler(req(headers, body))).status).toBe(400);
  });

  it("rejects missing headers without throwing", async () => {
    expect((await handler(req({}, "{}"))).status).toBe(400);
  });
});

describe("webhook + poller hybrid dedupe", () => {
  const idx = nacl.sign.keyPair();
  const pub = bs58.encode(idx.publicKey);
  let dir: string;
  const settledRow = {
    callId: "cid-h",
    agentPubkey: "AGENT",
    endpointSlug: "dummy",
    premiumLamports: "100",
    refundLamports: "9000",
    latencyMs: 50,
    breach: true,
    breachReason: "server_error",
    source: "proxy",
    ts: "2026-05-18T00:00:00.000Z",
    settledAt: "2026-05-18T00:00:06.000Z",
    signature: "BATCHSIG",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-wh-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fetchImpl(): typeof fetch {
    return (async (u: string) => {
      const url = String(u);
      if (url.endsWith("/.well-known/endpoints")) {
        return new Response(
          JSON.stringify({
            cacheTtlSec: 3600,
            endpoints: [
              {
                slug: "dummy",
                hostnames: ["dummy.pactnetwork.io"],
                premiumBps: 100,
                paused: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/dummy/")) {
        return new Response("upstream 503", {
          status: 503,
          headers: {
            "X-Pact-Call-Id": "cid-h",
            "X-Pact-Outcome": "server_error",
            "X-Pact-Premium": "100",
            "X-Pact-Refund": "9000",
          },
        });
      }
      if (url.includes("/api/agents/")) {
        return new Response(JSON.stringify([settledRow]), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    }) as unknown as typeof fetch;
  }

  async function makePact() {
    const pact = await createPact({
      network: "mainnet",
      signer: Keypair.generate(),
      storagePath: join(dir, "obs.jsonl"),
      fetchImpl: fetchImpl(),
      indexerPollIntervalMs: 60_000,
      installSignalHandlers: false,
      webhook: { indexerSigningKey: pub },
    });
    const billed: bigint[] = [];
    const refunds: bigint[] = [];
    pact.on("billed", (e) => billed.push(e.premiumLamports));
    pact.on("refund", (e) => refunds.push(e.refundLamports));
    return { pact, billed, refunds };
  }

  function deliver(pact: { webhookHandler?: Function }) {
    const body = JSON.stringify({
      type: "settlement.calls",
      version: 1,
      agentPubkey: "AGENT",
      calls: [
        {
          callId: "cid-h",
          agentPubkey: "AGENT",
          endpointSlug: "dummy",
          premiumLamports: "100",
          refundLamports: "9000",
          breach: true,
          settledAt: "2026-05-18T00:00:06.000Z",
          signature: "BATCHSIG",
        },
      ],
    });
    const headers = signLikeIndexer({
      secretKey: idx.secretKey,
      pub,
      path: PATH,
      ts: Date.now(),
      nonce: bs58.encode(nacl.randomBytes(16)),
      body,
    });
    return (pact.webhookHandler as Function)({
      method: "POST",
      path: PATH,
      headers,
      body,
    });
  }

  it("webhook first then poller flush: billed/refund emitted exactly once", async () => {
    const { pact, billed, refunds } = await makePact();
    await pact.fetch("https://dummy.pactnetwork.io/q?fail=1"); // buffers cid-h
    const r = await deliver(pact);
    expect(r.status).toBe(202);
    expect(billed).toEqual([100n]);
    expect(refunds).toEqual([9000n]);
    // Poller flush now sees cid-h already reconciled -> no second emit.
    await pact.shutdown();
    expect(billed).toEqual([100n]);
    expect(refunds).toEqual([9000n]);
    expect(pact.stats().pendingCalls).toBe(0);
  });

  it("poller first then webhook: no double-emit", async () => {
    const { pact, billed, refunds } = await makePact();
    await pact.fetch("https://dummy.pactnetwork.io/q?fail=1");
    await pact.shutdown(); // poller flush reconciles via indexer
    expect(billed).toEqual([100n]);
    expect(refunds).toEqual([9000n]);
    // Late webhook for the same call: recordSettled sees it not pending.
    const r = await deliver(pact);
    expect(r.status).toBe(202);
    expect(billed).toEqual([100n]);
    expect(refunds).toEqual([9000n]);
  });
});
