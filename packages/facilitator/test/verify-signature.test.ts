// Mirrors packages/market-proxy/test/verify-signature.test.ts — the facilitator
// reuses the same ed25519 canonical-payload scheme, so the CLI uses ONE signer.
// Differences from the market-proxy copy: no unauthenticated demo path (missing
// x-pact-agent → 401), and x-pact-project is NOT required.

import { describe, test, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  verifyPactSignature,
  buildSignaturePayload,
  createInMemoryReplayCache,
  DEFAULT_SKEW_MS,
  DEFAULT_REPLAY_TTL_MS,
} from "../src/middleware/verify-signature.js";

const PATH = "/v1/coverage/register";

function freshKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    pubkeyB58: bs58.encode(kp.publicKey),
  };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function buildSignedHeaders(opts: {
  keypair: ReturnType<typeof freshKeypair>;
  method: string;
  path: string;
  body?: string;
  timestampMs: number;
  nonce?: string;
}): Record<string, string> {
  const nonce = opts.nonce ?? bs58.encode(randomBytes(16));
  const body = opts.body ?? "";
  const bodyHash = body ? sha256Hex(body) : "";
  const payload = buildSignaturePayload({
    method: opts.method,
    path: opts.path,
    timestampMs: opts.timestampMs,
    nonce,
    bodyHash,
  });
  const sig = nacl.sign.detached(
    new TextEncoder().encode(payload),
    opts.keypair.secretKey,
  );
  return {
    "x-pact-agent": opts.keypair.pubkeyB58,
    "x-pact-timestamp": String(opts.timestampMs),
    "x-pact-nonce": nonce,
    "x-pact-signature": bs58.encode(sig),
  };
}

function makeApp(opts: { now?: () => number; replayTtlMs?: number } = {}) {
  const app = new Hono();
  app.use(
    PATH,
    verifyPactSignature({
      now: opts.now,
      replayTtlMs: opts.replayTtlMs,
      replayCache: createInMemoryReplayCache(
        opts.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS,
      ),
    }),
  );
  app.post(PATH, (c) =>
    c.json({ ok: true, agent: c.get("verifiedAgent") ?? null }),
  );
  return app;
}

const FIXED_NOW = 1_700_000_000_000;

describe("facilitator verifyPactSignature middleware", () => {
  let kp: ReturnType<typeof freshKeypair>;
  beforeEach(() => {
    kp = freshKeypair();
  });

  test("happy path: valid signed POST reaches the handler with verifiedAgent set", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const body = JSON.stringify({ agent: kp.pubkeyB58 });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      body,
      timestampMs: FIXED_NOW,
    });
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; agent: string };
    expect(json.ok).toBe(true);
    expect(json.agent).toBe(kp.pubkeyB58);
  });

  test("no x-pact-agent header → 401 pact_auth_missing (no demo path here)", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("pact_auth_missing");
  });

  test("x-pact-project is NOT required", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const body = JSON.stringify({ x: 1 });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      body,
      timestampMs: FIXED_NOW,
    });
    // (no x-pact-project at all)
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(res.status).toBe(200);
  });

  for (const header of [
    "x-pact-timestamp",
    "x-pact-nonce",
    "x-pact-signature",
  ] as const) {
    test(`missing ${header} → 401 pact_auth_missing`, async () => {
      const app = makeApp({ now: () => FIXED_NOW });
      const headers = buildSignedHeaders({
        keypair: kp,
        method: "POST",
        path: PATH,
        timestampMs: FIXED_NOW,
      });
      delete (headers as Record<string, string>)[header];
      const res = await app.request(PATH, { method: "POST", headers });
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("pact_auth_missing");
    });
  }

  test("timestamp outside skew window → 401 pact_auth_stale", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      timestampMs: FIXED_NOW - (DEFAULT_SKEW_MS + 1_000),
    });
    const res = await app.request(PATH, { method: "POST", headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("pact_auth_stale");
  });

  test("nonce replay within TTL → 401 pact_auth_replay", async () => {
    const app = makeApp({ now: () => FIXED_NOW, replayTtlMs: 60_000 });
    const body = JSON.stringify({ agent: kp.pubkeyB58 });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      body,
      timestampMs: FIXED_NOW,
    });
    const first = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(second.status).toBe(401);
    expect(((await second.json()) as { error: string }).error).toBe("pact_auth_replay");
  });

  test("body tampered after signing → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const body = JSON.stringify({ verdict: "server_error" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      body,
      timestampMs: FIXED_NOW,
    });
    const tampered = body.replace("server_error", "success");
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: tampered,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("pact_auth_bad_sig");
  });

  test("signed by a different key than x-pact-agent → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const body = JSON.stringify({ a: 1 });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      body,
      timestampMs: FIXED_NOW,
    });
    headers["x-pact-agent"] = freshKeypair().pubkeyB58;
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("pact_auth_bad_sig");
  });

  test("malformed signature bytes → 401, no panic", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: PATH,
      timestampMs: FIXED_NOW,
    });
    headers["x-pact-signature"] = "!!!not-base58!!!";
    const res = await app.request(PATH, { method: "POST", headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("pact_auth_bad_sig");
  });
});
