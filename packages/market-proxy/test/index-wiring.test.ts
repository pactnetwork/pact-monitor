// Exercises the REAL index.ts wiring (createApp) end-to-end: the
// verifyPactSignature middleware mounted with the getEndpointNetwork resolver
// that maps slug -> EndpointRegistry -> network, so the EVM/Solana cross-mode
// guard (finding 3) is enforced per-endpoint. Not a middleware unit test — it
// builds the app via createApp with a fixture EndpointRegistry over a fake pg.
//
// Auth outcome is what's asserted: a 401 means the auth middleware rejected; a
// non-401 means auth let the request through to proxyRoute (which then 500s on
// the uninitialized global AppContext — that's expected and not an auth
// failure, mirroring the e2e #1 `expect(status).not.toBe(401)` contract).

import { describe, test, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { EndpointRegistry } from "../src/lib/endpoints.js";
import { buildSignaturePayload } from "../src/middleware/verify-signature.js";

// index.ts eagerly parses env (via proxyRoute -> lib/context -> env), so the
// required vars must be present before it is imported. main() is guarded by an
// entrypoint check, so importing it does NOT boot the server.
function stubEnv(): void {
  process.env.PG_URL = "postgres://test:test@localhost:5432/test";
  process.env.RPC_URL = "https://rpc.test.invalid";
  process.env.PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";
  process.env.USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  process.env.PUBSUB_PROJECT = "test-project";
  process.env.PUBSUB_TOPIC = "test-topic";
  process.env.ENDPOINTS_RELOAD_TOKEN = "0123456789abcdef0123";
}

type CreateApp = typeof import("../src/index.js").createApp;
let createApp: CreateApp;

beforeAll(async () => {
  stubEnv();
  ({ createApp } = await import("../src/index.js"));
});

const ARC_SLUG = "arc-ep";
const SOL_SLUG = "sol-ep";

function endpointRow(slug: string, network: string) {
  return {
    slug,
    network,
    flatPremiumLamports: "1000",
    percentBps: 0,
    slaLatencyMs: 200,
    imputedCostLamports: "5000",
    exposureCapPerHourLamports: "1000000",
    paused: false,
    upstreamBase: "https://upstream.test.invalid",
    displayName: slug,
  };
}

/** Real EndpointRegistry over a fake pg returning one arc + one solana row. */
function makeRegistry(): EndpointRegistry {
  const rows = [
    endpointRow(ARC_SLUG, "arc-testnet"),
    endpointRow(SOL_SLUG, "solana-devnet"),
  ];
  const fakePg = { query: async () => ({ rows }) };
  return new EndpointRegistry(fakePg as never);
}

function makeApp() {
  return createApp({
    // requireBetaKey pg — unused while the gate flag is off.
    pg: { query: async () => ({ rows: [] }) } as never,
    betaGateFlag: { isBetaGateEnabled: async () => false } as never,
    registry: makeRegistry(),
  });
}

function freshSolanaKeypair() {
  const kp = nacl.sign.keyPair();
  return { secretKey: kp.secretKey, pubkeyB58: bs58.encode(kp.publicKey) };
}

function solanaHeaders(path: string): Record<string, string> {
  const kp = freshSolanaKeypair();
  const nonce = bs58.encode(randomBytes(16));
  // createApp wires verifyPactSignature with the real Date.now(), so sign with
  // a current timestamp (within the skew window).
  const timestampMs = Date.now();
  const payload = buildSignaturePayload({
    method: "GET",
    path,
    timestampMs,
    nonce,
    bodyHash: "",
  });
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), kp.secretKey);
  return {
    "x-pact-agent": kp.pubkeyB58,
    "x-pact-timestamp": String(timestampMs),
    "x-pact-nonce": nonce,
    "x-pact-signature": bs58.encode(sig),
    "x-pact-project": "demo",
  };
}

async function evmHeaders(path: string): Promise<Record<string, string>> {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = bs58.encode(randomBytes(16));
  const timestampMs = Date.now();
  const payload = buildSignaturePayload({
    method: "GET",
    path,
    timestampMs,
    nonce,
    bodyHash: "",
  });
  const signature = await account.signMessage({ message: payload });
  return {
    "x-pact-agent": account.address,
    "x-pact-timestamp": String(timestampMs),
    "x-pact-nonce": nonce,
    "x-pact-signature": signature,
    "x-pact-project": "demo",
  };
}

describe("index.ts createApp wiring — EVM/Solana cross-mode auth (finding 3)", () => {
  test("EVM agent (0x / EIP-191) on an arc-testnet endpoint authenticates", async () => {
    const app = makeApp();
    const path = `/v1/${ARC_SLUG}/`;
    const resp = await app.request(path, {
      method: "GET",
      headers: await evmHeaders(path),
    });
    // Auth passed (non-401); proxyRoute then errors on the uninitialized
    // global AppContext, which is not an auth failure.
    expect(resp.status).not.toBe(401);
  });

  test("Solana agent (Ed25519) on a solana-devnet endpoint authenticates (regression)", async () => {
    const app = makeApp();
    const path = `/v1/${SOL_SLUG}/`;
    const resp = await app.request(path, {
      method: "GET",
      headers: solanaHeaders(path),
    });
    expect(resp.status).not.toBe(401);
  });

  test("cross-mode: EVM 0x agent on a solana-devnet endpoint → 401", async () => {
    const app = makeApp();
    const path = `/v1/${SOL_SLUG}/`;
    const resp = await app.request(path, {
      method: "GET",
      headers: await evmHeaders(path),
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("cross-mode: Solana Ed25519 agent on an arc-testnet endpoint → 401", async () => {
    const app = makeApp();
    const path = `/v1/${ARC_SLUG}/`;
    const resp = await app.request(path, {
      method: "GET",
      headers: solanaHeaders(path),
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe("pact_auth_bad_sig");
  });

  test("no x-pact-agent (dashboard demo) passes through unauthenticated", async () => {
    const app = makeApp();
    const path = `/v1/${SOL_SLUG}/?pact_wallet=demo`;
    const resp = await app.request(path, { method: "GET" });
    // The middleware is a no-op without x-pact-agent; the request flows to
    // proxyRoute (non-401).
    expect(resp.status).not.toBe(401);
  });
});
