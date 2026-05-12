// End-to-end-ish tests for POST /v1/coverage/register, GET /v1/coverage/:id,
// GET /.well-known/pay-coverage and GET /health, driven through the real Hono
// app (createApp) with a mocked AppContext (no Postgres / RPC / Pub/Sub).

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

import {
  MemoryEventPublisher,
  type PaySettlementEvent,
} from "../src/lib/events.js";

// ---- mocked AppContext ------------------------------------------------------

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYEE = "PayeePubkey1111111111111111111111111111111";
const SIG = "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk";
const RESOURCE = "https://merchant.example/api/quote";

interface MockState {
  // payment-verify
  paymentOk: boolean;
  observedAmount: bigint;
  paymentReason: string;
  // allowance check
  allowanceEligible: boolean;
  allowanceReason: "insufficient_balance" | "insufficient_allowance" | "no_ata";
  allowanceThrows: boolean;
  // pool config rows (keyed by slug); empty → env-fallback
  endpointRows: Record<string, {
    flatPremiumLamports: bigint;
    imputedCostLamports: bigint;
    slaLatencyMs: number;
    exposureCapPerHourLamports: bigint;
    paused: boolean;
  }>;
  // Call rows for GET /v1/coverage/:id (keyed by callId)
  callRows: Record<string, Record<string, unknown>>;
}

const state: MockState = {
  paymentOk: true,
  observedAmount: 1_000_000n,
  paymentReason: "no_matching_transfer",
  allowanceEligible: true,
  allowanceReason: "insufficient_allowance",
  allowanceThrows: false,
  endpointRows: {},
  callRows: {},
};

const publisher = new MemoryEventPublisher();

const PAY_DEFAULTS = {
  slug: "pay-default",
  flatPremiumLamports: 1_000n,
  imputedCostLamports: 1_000_000n, // per-call refund ceiling ($1.00)
  slaLatencyMs: 10_000,
  exposureCapPerHourLamports: 5_000_000n,
};

const mockPg = {
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (/FROM "Endpoint"/.test(sql)) {
      const slug = params[0] as string;
      const row = state.endpointRows[slug];
      return { rows: row ? [{ slug, ...row }] : [] };
    }
    if (/FROM "Call"/.test(sql)) {
      const id = params[0] as string;
      const row = state.callRows[id];
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  }),
};

const mockAllowanceCheck = {
  check: vi.fn(async (_pubkey: string, _required: bigint) => {
    if (state.allowanceThrows) throw new Error("rpc down");
    if (state.allowanceEligible) {
      return { eligible: true as const, ataBalance: 5_000_000n, allowance: 5_000_000n };
    }
    return { eligible: false as const, reason: state.allowanceReason, ataBalance: 0n, allowance: 0n };
  }),
};

// Mock the payment-verify module wholesale so the route gets a deterministic
// answer without touching @solana/web3.js.
vi.mock("../src/lib/payment-verify.js", () => ({
  verifyPayment: vi.fn(async () =>
    state.paymentOk
      ? { ok: true, observedAmount: state.observedAmount }
      : { ok: false, reason: state.paymentReason },
  ),
}));

vi.mock("../src/lib/context.js", () => ({
  getContext: () => ({
    pg: mockPg,
    connection: {} as unknown,
    allowanceCheck: mockAllowanceCheck,
    publisher,
    usdcMint: USDC,
    payDefaults: PAY_DEFAULTS,
  }),
  initContext: vi.fn(),
  setContext: vi.fn(),
  resetContext: vi.fn(),
  payDefaultsFromEnv: () => PAY_DEFAULTS,
}));

// Import AFTER the mocks are registered.
const { createApp } = await import("../src/index.js");

// ---- signing helper ---------------------------------------------------------

function buildSignaturePayload(args: {
  method: string;
  path: string;
  timestampMs: number;
  nonce: string;
  bodyHash: string;
}): string {
  return `v1\n${args.method.toUpperCase()}\n${args.path}\n${args.timestampMs}\n${args.nonce}\n${args.bodyHash}`;
}
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const agentKp = nacl.sign.keyPair();
const AGENT = bs58.encode(agentKp.publicKey);

function signedRegisterRequest(overrides: Partial<Record<string, unknown>> = {}, opts: { signWith?: Uint8Array; agentHeader?: string; nowMs?: number } = {}) {
  const body = JSON.stringify({
    agent: AGENT,
    payee: PAYEE,
    resource: RESOURCE,
    scheme: "x402",
    paymentSignature: SIG,
    amountBaseUnits: "1000000",
    asset: USDC,
    verdict: "server_error",
    latencyMs: 1840,
    ...overrides,
  });
  const ts = opts.nowMs ?? Date.now();
  const nonce = bs58.encode(randomBytes(16));
  const path = "/v1/coverage/register";
  const payload = buildSignaturePayload({ method: "POST", path, timestampMs: ts, nonce, bodyHash: sha256Hex(body) });
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), opts.signWith ?? agentKp.secretKey);
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pact-agent": opts.agentHeader ?? AGENT,
      "x-pact-timestamp": String(ts),
      "x-pact-nonce": nonce,
      "x-pact-signature": bs58.encode(sig),
    },
    body,
  });
}

// ---- tests ------------------------------------------------------------------

describe("facilitator app", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
    publisher.reset();
    mockPg.query.mockClear();
    mockAllowanceCheck.check.mockClear();
    state.paymentOk = true;
    state.observedAmount = 1_000_000n;
    state.allowanceEligible = true;
    state.allowanceThrows = false;
    state.endpointRows = {};
    state.callRows = {};
  });

  test("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; service: string };
    expect(json.status).toBe("ok");
    expect(json.service).toBe("pact-facilitator");
  });

  test("GET /.well-known/pay-coverage — metadata + subsidised disclosure + env-fallback pool", async () => {
    const res = await app.request("/.well-known/pay-coverage");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      model: string;
      supportedSchemes: string[];
      pools: Array<{ slug: string; flatPremiumBaseUnits: string; perCallRefundCeilingBaseUnits: string; exposureCapPerHourBaseUnits: string; configSource: string }>;
      premiumFunding: string;
      refundFunding: string;
      disclosure: string;
      unverifiedReceiptsAccepted: boolean;
      unverifiedDisclosure: string;
    };
    expect(json.model).toBe("side-call");
    expect(json.supportedSchemes).toEqual(["x402", "mpp"]);
    expect(json.pools[0].slug).toBe("pay-default");
    expect(json.pools[0].flatPremiumBaseUnits).toBe("1000");
    expect(json.pools[0].perCallRefundCeilingBaseUnits).toBe("1000000");
    expect(json.pools[0].exposureCapPerHourBaseUnits).toBe("5000000");
    expect(json.pools[0].configSource).toBe("env-fallback");
    expect(json.premiumFunding).toBe("agent_allowance");
    expect(json.refundFunding).toBe("pact_subsidised_launch_pool");
    expect(json.disclosure).toMatch(/subsidised/i);
    expect(json.unverifiedReceiptsAccepted).toBe(true);
    expect(json.unverifiedDisclosure).toMatch(/exposure cap/i);
  });

  test("GET /.well-known/pay-coverage — uses DB row when present", async () => {
    state.endpointRows["pay-default"] = {
      flatPremiumLamports: 2_500n,
      imputedCostLamports: 50_000n,
      slaLatencyMs: 8_000,
      exposureCapPerHourLamports: 5_000_000n,
      paused: false,
    };
    const res = await app.request("/.well-known/pay-coverage");
    const json = (await res.json()) as { pools: Array<{ flatPremiumBaseUnits: string; configSource: string }> };
    expect(json.pools[0].flatPremiumBaseUnits).toBe("2500");
    expect(json.pools[0].configSource).toBe("db");
  });

  test("register happy path (covered breach) — publishes a pay.sh SettlementEvent, returns settlement_pending", async () => {
    const res = await app.request(signedRegisterRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      coverageId: string;
      status: string;
      premiumBaseUnits: string;
      refundBaseUnits: string;
      poolSlug: string;
      outcome: string;
      observedPaymentBaseUnits: string;
      reason: string | null;
    };
    expect(json.status).toBe("settlement_pending");
    expect(json.premiumBaseUnits).toBe("1000");
    expect(json.refundBaseUnits).toBe("1000000");
    expect(json.poolSlug).toBe("pay-default");
    expect(json.outcome).toBe("server_error");
    expect(json.observedPaymentBaseUnits).toBe("1000000");
    expect(json.reason).toBeNull();
    expect((json as { verified: boolean }).verified).toBe(true);
    expect(json.coverageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    expect(publisher.events).toHaveLength(1);
    const ev: PaySettlementEvent = publisher.events[0];
    expect(ev.source).toBe("pay.sh");
    expect(ev.endpointSlug).toBe("pay-default");
    expect(ev.agentPubkey).toBe(AGENT);
    expect(ev.premiumLamports).toBe("1000");
    expect(ev.refundLamports).toBe("1000000");
    expect(ev.outcome).toBe("server_error");
    expect(ev.payee).toBe(PAYEE);
    expect(ev.resource).toBe(RESOURCE);
    expect(ev.callId).toBe(json.coverageId);
    expect(ev.coverageId).toBe(json.coverageId);
    expect(ev.verified).toBe(true);
    expect(ev.latencyMs).toBe(1840);
  });

  test("register WITHOUT payee+paymentSignature (pay.sh degrade mode) — verified:false, settlement_pending, event published with payee:null + verified:false", async () => {
    // pay 0.16.0 logs neither the merchant address nor the settle tx sig, so
    // `pact pay` sends both ABSENT. The facilitator must accept this.
    const body: Record<string, unknown> = {
      agent: AGENT,
      resource: RESOURCE,
      scheme: "x402",
      amountBaseUnits: "1000000",
      asset: USDC,
      verdict: "server_error",
      latencyMs: 1840,
    };
    // build a signed request from a hand-rolled body (signedRegisterRequest
    // always includes payee/paymentSignature, so we sign manually here)
    const json = JSON.stringify(body);
    const ts = Date.now();
    const nonce = bs58.encode(randomBytes(16));
    const path = "/v1/coverage/register";
    const payload = `v1\nPOST\n${path}\n${ts}\n${nonce}\n${createHash("sha256").update(json, "utf8").digest("hex")}`;
    const sig = nacl.sign.detached(new TextEncoder().encode(payload), agentKp.secretKey);
    const req = new Request(`http://local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pact-agent": AGENT,
        "x-pact-timestamp": String(ts),
        "x-pact-nonce": nonce,
        "x-pact-signature": bs58.encode(sig),
      },
      body: json,
    });
    const res = await app.request(req);
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      coverageId: string;
      status: string;
      verified: boolean;
      premiumBaseUnits: string;
      refundBaseUnits: string;
      observedPaymentBaseUnits: string | null;
      outcome: string;
    };
    expect(out.status).toBe("settlement_pending");
    expect(out.verified).toBe(false);
    expect(out.premiumBaseUnits).toBe("1000");
    expect(out.refundBaseUnits).toBe("1000000");
    expect(out.observedPaymentBaseUnits).toBeNull();
    expect(out.outcome).toBe("server_error");
    expect(out.coverageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    expect(publisher.events).toHaveLength(1);
    const ev: PaySettlementEvent = publisher.events[0];
    expect(ev.source).toBe("pay.sh");
    expect(ev.verified).toBe(false);
    expect(ev.payee).toBeNull();
    expect(ev.resource).toBe(RESOURCE);
    expect(ev.endpointSlug).toBe("pay-default");
    expect(ev.callId).toBe(out.coverageId);
    expect(ev.coverageId).toBe(out.coverageId);
  });

  test("register with ONLY paymentSignature (no payee) — still unverified path (verified:false)", async () => {
    // verification needs BOTH; one alone is treated as the unverified case.
    const res = await app.request(
      signedRegisterRequest({ payee: undefined } as Record<string, unknown>),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { status: string; verified: boolean };
    expect(out.status).toBe("settlement_pending");
    expect(out.verified).toBe(false);
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].verified).toBe(false);
    expect(publisher.events[0].payee).toBeNull();
  });

  test("register WITH both payee+paymentSignature (valid) — verified:true, verifyPayment called", async () => {
    const { verifyPayment } = (await import("../src/lib/payment-verify.js")) as unknown as {
      verifyPayment: ReturnType<typeof vi.fn>;
    };
    verifyPayment.mockClear();
    const res = await app.request(signedRegisterRequest());
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      status: string;
      verified: boolean;
      observedPaymentBaseUnits: string;
    };
    expect(out.status).toBe("settlement_pending");
    expect(out.verified).toBe(true);
    expect(out.observedPaymentBaseUnits).toBe("1000000");
    expect(verifyPayment).toHaveBeenCalledTimes(1);
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].verified).toBe(true);
    expect(publisher.events[0].payee).toBe(PAYEE);
  });

  test("register: malformed payee WHEN PRESENT → rejected (bad_payee, verified:false)", async () => {
    const res = await app.request(signedRegisterRequest({ payee: "not-a-pubkey-$$$" }));
    expect(res.status).toBe(400);
    const out = (await res.json()) as { code: string; status: string; verified: boolean };
    expect(out.code).toBe("bad_payee");
    expect(out.status).toBe("rejected");
    expect(out.verified).toBe(false);
    expect(publisher.events).toHaveLength(0);
  });

  test("register: malformed paymentSignature WHEN PRESENT → rejected (bad_payment_signature)", async () => {
    const res = await app.request(signedRegisterRequest({ paymentSignature: "tooshort" }));
    expect(res.status).toBe(400);
    const out = (await res.json()) as { code: string; verified: boolean };
    expect(out.code).toBe("bad_payment_signature");
    expect(out.verified).toBe(false);
  });

  test("register happy path (success verdict) — premium charged, refund 0", async () => {
    const res = await app.request(signedRegisterRequest({ verdict: "success" }));
    const json = (await res.json()) as { status: string; premiumBaseUnits: string; refundBaseUnits: string; outcome: string };
    expect(json.status).toBe("settlement_pending");
    expect(json.premiumBaseUnits).toBe("1000");
    expect(json.refundBaseUnits).toBe("0");
    expect(json.outcome).toBe("ok");
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].refundLamports).toBe("0");
  });

  test("register: client_error verdict → uncovered (not_covered_outcome), no event", async () => {
    const res = await app.request(signedRegisterRequest({ verdict: "client_error" }));
    const json = (await res.json()) as { status: string; reason: string; premiumBaseUnits: string };
    expect(json.status).toBe("uncovered");
    expect(json.reason).toBe("not_covered_outcome");
    expect(json.premiumBaseUnits).toBe("0");
    expect(publisher.events).toHaveLength(0);
  });

  test("register: no allowance → uncovered (no_allowance), no event", async () => {
    state.allowanceEligible = false;
    state.allowanceReason = "insufficient_allowance";
    const res = await app.request(signedRegisterRequest());
    const json = (await res.json()) as { status: string; reason: string; premiumBaseUnits: string; refundBaseUnits: string };
    expect(json.status).toBe("uncovered");
    expect(json.reason).toBe("no_allowance");
    expect(json.premiumBaseUnits).toBe("1000");
    expect(json.refundBaseUnits).toBe("0");
    expect(publisher.events).toHaveLength(0);
  });

  test("register: insufficient balance → uncovered (insufficient_balance)", async () => {
    state.allowanceEligible = false;
    state.allowanceReason = "insufficient_balance";
    const res = await app.request(signedRegisterRequest());
    const json = (await res.json()) as { status: string; reason: string };
    expect(json.status).toBe("uncovered");
    expect(json.reason).toBe("insufficient_balance");
  });

  test("register: allowance check RPC blip → uncovered (allowance_check_unavailable)", async () => {
    state.allowanceThrows = true;
    const res = await app.request(signedRegisterRequest());
    const json = (await res.json()) as { status: string; reason: string };
    expect(json.status).toBe("uncovered");
    expect(json.reason).toBe("allowance_check_unavailable");
    expect(publisher.events).toHaveLength(0);
  });

  test("register: pool paused → uncovered (pool_paused)", async () => {
    state.endpointRows["pay-default"] = {
      flatPremiumLamports: 1_000n,
      imputedCostLamports: 10_000n,
      slaLatencyMs: 10_000,
      exposureCapPerHourLamports: 1_000_000n,
      paused: true,
    };
    const res = await app.request(signedRegisterRequest());
    const json = (await res.json()) as { status: string; reason: string };
    expect(json.status).toBe("uncovered");
    expect(json.reason).toBe("pool_paused");
    expect(publisher.events).toHaveLength(0);
  });

  test("register: bad payment signature on-chain → rejected (HTTP 422)", async () => {
    state.paymentOk = false;
    state.paymentReason = "no_matching_transfer";
    const res = await app.request(signedRegisterRequest());
    expect(res.status).toBe(422);
    const json = (await res.json()) as { status: string; code: string };
    expect(json.status).toBe("rejected");
    expect(json.code).toBe("payment_no_matching_transfer");
    expect(publisher.events).toHaveLength(0);
  });

  test("register: tx not found → rejected (HTTP 422, payment_tx_not_found)", async () => {
    state.paymentOk = false;
    state.paymentReason = "tx_not_found";
    const res = await app.request(signedRegisterRequest());
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("payment_tx_not_found");
  });

  test("register: x-pact-agent header != body.agent → 401 agent_mismatch", async () => {
    const other = nacl.sign.keyPair();
    const req = signedRegisterRequest({}, { agentHeader: bs58.encode(other.publicKey), signWith: other.secretKey });
    const res = await app.request(req);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { status: string; code: string };
    expect(json.status).toBe("rejected");
    expect(json.code).toBe("agent_mismatch");
  });

  test("register: unsigned request → 401 pact_auth_missing", async () => {
    const res = await app.request("http://local/v1/coverage/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: AGENT, payee: PAYEE, resource: RESOURCE, scheme: "x402", paymentSignature: SIG, amountBaseUnits: "1000000", asset: USDC, verdict: "server_error" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("pact_auth_missing");
  });

  test("register: replayed nonce → 401 pact_auth_replay", async () => {
    const req = signedRegisterRequest();
    const first = await app.request(req.clone());
    expect(first.status).toBe(200);
    const second = await app.request(req);
    expect(second.status).toBe(401);
    expect(((await second.json()) as { error: string }).error).toBe("pact_auth_replay");
  });

  test("register: unsupported asset → rejected", async () => {
    const res = await app.request(signedRegisterRequest({ asset: "NotUSDC1111111111111111111111111111111111" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("unsupported_asset");
  });

  test("register: asset is a USDC mint but not THIS facilitator's mint → rejected", async () => {
    // devnet USDC, but the mocked context's usdcMint is mainnet USDC
    const res = await app.request(signedRegisterRequest({ asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("asset_network_mismatch");
  });

  test("register: unknown verdict → rejected", async () => {
    const res = await app.request(signedRegisterRequest({ verdict: "teapot" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_verdict");
  });

  test("register: bad scheme → rejected", async () => {
    const res = await app.request(signedRegisterRequest({ scheme: "venmo" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_scheme");
  });

  test("register: zero amount → rejected", async () => {
    const res = await app.request(signedRegisterRequest({ amountBaseUnits: "0" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_amount");
  });

  test("GET /v1/coverage/:id — no row yet → settlement_pending (+ callId / settleBatchSignature aliases)", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const res = await app.request(`/v1/coverage/${id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      coverageId: string; callId: string; status: string; settled: boolean;
      settleBatchSignature: string | null; settlementSignature: string | null;
    };
    expect(json.status).toBe("settlement_pending");
    expect(json.settled).toBe(false);
    expect(json.callId).toBe(id);
    expect(json.coverageId).toBe(id);
    expect(json.settleBatchSignature).toBeNull();
    expect(json.settlementSignature).toBeNull();
  });

  test("GET /v1/coverage/:id — row exists → settled with signature + payee/resource", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    state.callRows[id] = {
      callId: id,
      agentPubkey: AGENT,
      endpointSlug: "pay-default",
      premiumLamports: 1000n,
      refundLamports: 10000n,
      latencyMs: 1840,
      breach: true,
      breachReason: "server_error",
      source: "pay.sh",
      payee: PAYEE,
      resource: RESOURCE,
      ts: new Date("2026-05-11T10:00:00Z"),
      settledAt: new Date("2026-05-11T10:00:09Z"),
      signature: "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk",
    };
    const res = await app.request(`/v1/coverage/${id}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string; settled: boolean; settlementSignature: string; settleBatchSignature: string;
      callId: string; coverageId: string; source: string; payee: string; resource: string; breach: boolean;
    };
    expect(json.status).toBe("settled");
    expect(json.settled).toBe(true);
    expect(json.settlementSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(json.settleBatchSignature).toBe(json.settlementSignature);
    expect(json.callId).toBe(id);
    expect(json.coverageId).toBe(id);
    expect(json.source).toBe("pay.sh");
    expect(json.payee).toBe(PAYEE);
    expect(json.resource).toBe(RESOURCE);
    expect(json.breach).toBe(true);
  });

  test("GET /v1/coverage/:id — malformed id → 400", async () => {
    const res = await app.request("/v1/coverage/not-a-uuid");
    expect(res.status).toBe(400);
  });
});
