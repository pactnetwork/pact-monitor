// Verifies that the pact-cli ed25519 envelope (see
// packages/cli/src/lib/transport.ts) round-trips through the
// verifyPactSignature middleware. Tests exercise the middleware behind a
// minimal Hono app so we cover both the rejection paths and the
// passthrough-to-next behaviour.

import { describe, test, expect, beforeEach } from "vitest";
import { Hono, type Context } from "hono";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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
  /** When set, sign over the v2 payload and emit the `x-pact-network` header. */
  network?: string;
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
    network: opts.network,
  });
  const sig = nacl.sign.detached(
    new TextEncoder().encode(payload),
    opts.keypair.secretKey,
  );
  const headers: Record<string, string> = {
    "x-pact-agent": opts.keypair.pubkeyB58,
    "x-pact-timestamp": String(opts.timestampMs),
    "x-pact-nonce": nonce,
    "x-pact-signature": bs58.encode(sig),
    "x-pact-project": opts.project ?? PROJECT,
  };
  if (opts.network !== undefined) {
    headers["x-pact-network"] = opts.network;
  }
  return headers;
}

function makeApp(
  opts: {
    now?: () => number;
    replayTtlMs?: number;
    getEndpointNetwork?: (c: Context) => string | undefined;
  } = {},
) {
  const app = new Hono();
  app.use(
    "/v1/:slug/*",
    verifyPactSignature({
      now: opts.now,
      replayTtlMs: opts.replayTtlMs,
      replayCache: createInMemoryReplayCache(
        opts.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS,
      ),
      getEndpointNetwork: opts.getEndpointNetwork,
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

/** Build EIP-191 (personal_sign) signed headers for an EVM agent. */
async function buildEvmSignedHeaders(opts: {
  account: ReturnType<typeof privateKeyToAccount>;
  method: string;
  path: string;
  body?: string;
  timestampMs: number;
  nonce?: string;
  project?: string;
  /** When set, sign over the v2 payload and emit the `x-pact-network` header. */
  network?: string;
}): Promise<Record<string, string>> {
  const nonce = opts.nonce ?? bs58.encode(randomBytes(16));
  const body = opts.body ?? "";
  const bodyHash = body ? sha256Hex(body) : "";
  const payload = buildSignaturePayload({
    method: opts.method,
    path: opts.path,
    timestampMs: opts.timestampMs,
    nonce,
    bodyHash,
    network: opts.network,
  });
  const signature = await opts.account.signMessage({ message: payload });
  const headers: Record<string, string> = {
    "x-pact-agent": opts.account.address,
    "x-pact-timestamp": String(opts.timestampMs),
    "x-pact-nonce": nonce,
    "x-pact-signature": signature,
    "x-pact-project": opts.project ?? PROJECT,
  };
  if (opts.network !== undefined) {
    headers["x-pact-network"] = opts.network;
  }
  return headers;
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

// ---------------------------------------------------------------------------
// Finding 3 (mn-04 fix-WP T3): EVM auth mode + cross-mode guard.
// ---------------------------------------------------------------------------
describe("verifyPactSignature — EVM (secp256k1 / EIP-191) auth mode", () => {
  let account: ReturnType<typeof privateKeyToAccount>;
  beforeEach(() => {
    account = privateKeyToAccount(generatePrivateKey());
  });

  test("EVM agent (0x / EIP-191) authenticates and verifiedAgent is the 0x address", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; agent: string };
    expect(json.ok).toBe(true);
    // verifiedAgent is normalized to lowercase (PR #225 P0-3).
    expect(json.agent).toBe(account.address.toLowerCase());
  });

  test("EVM replay via address case-variance is rejected (PR #225 P0-3 replay-cache normalization)", async () => {
    // Threat: viem's verifyMessage is case-insensitive, so a captured request
    // replayed with a case-variant x-pact-agent still verifies. Before the fix
    // the case-sensitive replay key (`${agent}:${nonce}`) missed the cache and
    // let the replay through (double-billing). After normalization, both casings
    // collapse to one key → the second request is rejected as a replay.
    const app = makeApp({ now: () => FIXED_NOW, replayTtlMs: 60_000 });
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    // Sanity: the SDK ships a checksummed (mixed-case) address.
    expect(headers["x-pact-agent"]).not.toBe(
      headers["x-pact-agent"].toLowerCase(),
    );
    const first = await app.request(path, { method: "GET", headers });
    expect(first.status).toBe(200);

    // Replay: identical nonce + signature, agent header lowercased.
    const replay = {
      ...headers,
      "x-pact-agent": headers["x-pact-agent"].toLowerCase(),
    };
    const second = await app.request(path, { method: "GET", headers: replay });
    expect(second.status).toBe(401);
    const json = (await second.json()) as { error: string };
    expect(json.error).toBe("pact_auth_replay");
  });

  test("EVM agent with a tampered signature → 401 pact_auth_bad_sig", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    // Re-sign a different agent's message but claim the original address.
    const other = privateKeyToAccount(generatePrivateKey());
    headers["x-pact-signature"] = await other.signMessage({ message: "x" });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("Solana Ed25519 agent still authenticates against a solana-devnet endpoint (regression)", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: () => "solana-devnet",
    });
    const kp = freshKeypair();
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; agent: string };
    expect(json.agent).toBe(kp.pubkeyB58);
  });

  test("EVM agent authenticates against an arc-testnet endpoint (matching VM)", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: () => "arc-testnet",
    });
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(200);
  });

  test("cross-mode: 0x agent on a solana-devnet endpoint → 401", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: () => "solana-devnet",
    });
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("cross-mode: Ed25519 agent on an arc-testnet endpoint → 401", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: () => "arc-testnet",
    });
    const kp = freshKeypair();
    const path = `/v1/${SLUG}/`;
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });
});

// ---------------------------------------------------------------------------
// G-5: v2 signed payload with embedded `x-pact-network` field.
// Spec: docs/superpowers/.../sdk-evm-signing.md §8 (proxy column).
// ---------------------------------------------------------------------------
describe("verifyPactSignature — v2 payload (network field embedded)", () => {
  test("EVM happy path (v2): signed over base-sepolia, sent with matching x-pact-network → 200", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: (c) => c.req.header("x-pact-network"),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
      network: "base-sepolia",
    });
    expect(headers["x-pact-network"]).toBe("base-sepolia");
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; agent: string };
    // verifiedAgent is normalized to lowercase (PR #225 P0-3).
    expect(json.agent).toBe(account.address.toLowerCase());
  });

  test("EVM wrong-chain replay: signed for base-sepolia, sent with x-pact-network=arc-testnet → 401", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: (c) => c.req.header("x-pact-network"),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const path = `/v1/${SLUG}/`;
    const headers = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
      network: "base-sepolia",
    });
    // Replay: swap the network header. Both VMs (EVM agent / EVM network) match,
    // but the v2 payload reconstruction now uses "arc-testnet" → sig invalid.
    headers["x-pact-network"] = "arc-testnet";
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("Solana bs58 signature paired with a 0x agent (cross-VM payload swap) → 401", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const account = privateKeyToAccount(generatePrivateKey());
    const kp = freshKeypair();
    const path = `/v1/${SLUG}/`;
    // Build a Solana-signed envelope...
    const solHeaders = buildSignedHeaders({
      keypair: kp,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    // ...then claim the EVM 0x agent. bs58 signature + 0x agent → viem route
    // sees a non-hex signature → verifyMessage returns false → 401.
    const headers = {
      ...solHeaders,
      "x-pact-agent": account.address,
    };
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("EVM 0x signature paired with a bs58 Solana agent (cross-VM payload swap) → 401", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const account = privateKeyToAccount(generatePrivateKey());
    const kp = freshKeypair();
    const path = `/v1/${SLUG}/`;
    // Build an EVM-signed envelope...
    const evmHeaders = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    // ...then claim a Solana bs58 agent. 0x signature isn't valid bs58 → Solana
    // path decodes the sig string and bails before nacl.sign.detached.verify.
    const headers = {
      ...evmHeaders,
      "x-pact-agent": kp.pubkeyB58,
    };
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("v1 legacy (no network field) still accepted for Solana — compat window", async () => {
    const app = makeApp({ now: () => FIXED_NOW });
    const kp = freshKeypair();
    const path = `/v1/${SLUG}/`;
    // Default (no `network` arg) signs the v1 payload — same shape the CLI
    // still ships until its EVM follow-up lands.
    const headers = buildSignedHeaders({
      keypair: kp,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
    });
    expect(headers["x-pact-network"]).toBeUndefined();
    const resp = await app.request(path, { method: "GET", headers });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; agent: string };
    expect(json.agent).toBe(kp.pubkeyB58);
  });

  test("same-VM cross-network replay rejected for EVM (explicit threat-model test)", async () => {
    // Same threat as the wrong-chain test, named explicitly. Captured request
    // signed for `base-sepolia` cannot be replayed against any other EVM
    // network the agent is known to operate on.
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: (c) => c.req.header("x-pact-network"),
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const path = `/v1/${SLUG}/`;
    const captured = await buildEvmSignedHeaders({
      account,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
      network: "base-sepolia",
    });
    // Replay with the same agent + sig + nonce, swapped network only.
    captured["x-pact-network"] = "base-mainnet";
    const resp = await app.request(path, { method: "GET", headers: captured });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("Solana devnet→mainnet replay rejected (v2 captured, mainnet replay)", async () => {
    const app = makeApp({
      now: () => FIXED_NOW,
      getEndpointNetwork: (c) => c.req.header("x-pact-network"),
    });
    const kp = freshKeypair();
    const path = `/v1/${SLUG}/`;
    // Captured: v2 Solana request signed for solana-devnet.
    const captured = buildSignedHeaders({
      keypair: kp,
      method: "GET",
      path,
      timestampMs: FIXED_NOW,
      network: "solana-devnet",
    });
    captured["x-pact-network"] = "solana-mainnet";
    const resp = await app.request(path, { method: "GET", headers: captured });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });
});
