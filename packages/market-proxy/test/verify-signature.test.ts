// Verifies that the pact-cli ed25519 envelope (see
// packages/cli/src/lib/transport.ts) round-trips through the
// verifyPactSignature middleware. Tests exercise the middleware behind a
// minimal Hono app so we cover both the rejection paths and the
// passthrough-to-next behaviour.

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

const SLUG = "helius";
const PROJECT = "demo-project";

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
  project?: string;
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
    "x-pact-project": opts.project ?? PROJECT,
  };
}

function makeApp(opts: { now?: () => number; replayTtlMs?: number } = {}) {
  const app = new Hono();
  app.use(
    "/v1/:slug/*",
    verifyPactSignature({
      now: opts.now,
      replayTtlMs: opts.replayTtlMs,
      replayCache: createInMemoryReplayCache(
        opts.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS,
      ),
    }),
  );
  app.all("/v1/:slug/*", (c) =>
    c.json({
      ok: true,
      agent: c.get("verifiedAgent") ?? null,
    }),
  );
  return app;
}

const FIXED_NOW = 1_700_000_000_000;

describe("verifyPactSignature middleware", () => {
  let kp: ReturnType<typeof freshKeypair>;
  beforeEach(() => {
    kp = freshKeypair();
  });

  test("no x-pact-agent header → middleware is a no-op (legacy/demo path)", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const resp = await app.request("/v1/helius/?pact_wallet=demo", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "getHealth" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; agent: string | null };
    expect(body.ok).toBe(true);
    expect(body.agent).toBeNull();
  });

  test("happy path: valid signed request reaches the route handler", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getHealth" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      body,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; agent: string };
    expect(json.ok).toBe(true);
    expect(json.agent).toBe(kp.pubkeyB58);
  });

  test("empty-body GET signs over bodyHash = '' and verifies", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(200);
  });

  for (const header of [
    "x-pact-timestamp",
    "x-pact-nonce",
    "x-pact-signature",
    "x-pact-project",
  ] as const) {
    test(`missing ${header} → 401 pact_auth_missing`, async () => {
      const app = makeApp({ now: () => FIXED_NOW });
      const path = `/v1/${SLUG}/`;
      const headers = buildSignedHeaders({
        keypair: kp,
        method: "POST",
        path,
        timestampMs: FIXED_NOW,
      });
      delete (headers as Record<string, string>)[header];
      const resp = await app.request(path, { method: "POST", headers });
      expect(resp.status).toBe(401);
      const json = (await resp.json()) as { error: string };
      expect(json.error).toBe("pact_auth_missing");
    });
  }

  test("timestamp 31s in the past → 401 pact_auth_stale", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      timestampMs: FIXED_NOW - (DEFAULT_SKEW_MS + 1_000),
    });
    const resp = await app.request(path, { method: "POST", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_stale");
  });

  test("timestamp 31s in the future → 401 pact_auth_stale", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      timestampMs: FIXED_NOW + (DEFAULT_SKEW_MS + 1_000),
    });
    const resp = await app.request(path, { method: "POST", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_stale");
  });

  test("malformed timestamp → 401 pact_auth_stale", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      timestampMs: FIXED_NOW,
    });
    headers["x-pact-timestamp"] = "not-a-number";
    const resp = await app.request(path, { method: "POST", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_stale");
  });

  test("nonce replay within TTL → 401 pact_auth_replay", async () => {
    const app = makeApp({ now: () => FIXED_NOW, replayTtlMs: 60_000 });
    const path = `/v1/${SLUG}/`;
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getHealth" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      body,
      timestampMs: FIXED_NOW,
    });
    const first = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(second.status).toBe(401);
    const json = (await second.json()) as { error: string };
    expect(json.error).toBe("pact_auth_replay");
  });

  test("body tampered after signing → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getHealth" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      body,
      timestampMs: FIXED_NOW,
    });
    const tampered = body.replace("getHealth", "getBalance");
    const resp = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: tampered,
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("wrong pubkey in x-pact-agent (signed by a different key) → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getHealth" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      body,
      timestampMs: FIXED_NOW,
    });
    const other = freshKeypair();
    headers["x-pact-agent"] = other.pubkeyB58;
    const resp = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("path tampered after signing → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const signedPath = `/v1/${SLUG}/`;
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getHealth" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path: signedPath,
      body,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(`/v1/${SLUG}/?injected=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("malformed signature bytes → 401, no panic", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const body = JSON.stringify({ jsonrpc: "2.0", method: "getHealth" });
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      body,
      timestampMs: FIXED_NOW,
    });
    headers["x-pact-signature"] = "!!!not-base58!!!";
    const resp = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("signature bytes of wrong length → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "POST",
      path,
      timestampMs: FIXED_NOW,
    });
    headers["x-pact-signature"] = bs58.encode(new Uint8Array(32));
    const resp = await app.request(path, { method: "POST", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });
});
