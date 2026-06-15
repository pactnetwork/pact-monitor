// Tests for the facilitator.pactnetwork.io client: registerCoverage
// (happy path / uncovered / rejected / unreachable→graceful) and
// getCoverageStatus. The HTTP layer is mocked via a fetch override; no
// network is touched.

import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import {
  registerCoverage,
  getCoverageStatus,
  resolveFacilitatorUrl,
  DEFAULT_FACILITATOR_URL,
} from "../src/lib/facilitator.ts";
import { buildSignaturePayload } from "../src/lib/transport.ts";
import type { CoverageRegistrationPayload } from "../src/lib/x402-receipt.ts";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KP = Keypair.generate();
const PAYLOAD: CoverageRegistrationPayload = {
  agent: KP.publicKey.toBase58(),
  scheme: "x402",
  resource: "https://x.example/v1/q",
  amountBaseUnits: "50000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  verdict: "server_error",
  upstreamStatus: 503,
};

describe("registerCoverage: request shape", () => {
  test("POSTs to /v1/coverage/register with the canonical ed25519 signature headers", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const decision = await registerCoverage({
      keypair: KP,
      project: "my-agent",
      payload: PAYLOAD,
      facilitatorUrl: "https://facilitator.test",
      fetchImpl: fakeFetch((url, init) => {
        seenUrl = url;
        seenHeaders = (init.headers as Record<string, string>) ?? {};
        seenBody = (init.body as string) ?? "";
        return jsonResponse(200, {
          coverageId: "cov_abc",
          status: "settlement_pending",
          premiumBaseUnits: "1000",
          refundBaseUnits: "0",
          reason: "",
          callId: "00000000-0000-4000-8000-000000000001",
        });
      }),
    });

    expect(seenUrl).toBe("https://facilitator.test/v1/coverage/register");
    expect(seenHeaders["x-pact-agent"]).toBe(KP.publicKey.toBase58());
    expect(seenHeaders["x-pact-project"]).toBe("my-agent");
    expect(seenHeaders["content-type"]).toBe("application/json");
    expect(typeof seenHeaders["x-pact-timestamp"]).toBe("string");
    expect(typeof seenHeaders["x-pact-nonce"]).toBe("string");
    expect(typeof seenHeaders["x-pact-signature"]).toBe("string");

    // The signature must verify against the same canonical payload the
    // gateway path uses (v1\nMETHOD\nPATH\nTS\nNONCE\nBODY_SHA256_HEX).
    const ts = Number(seenHeaders["x-pact-timestamp"]);
    const nonce = seenHeaders["x-pact-nonce"];
    const bodyHash = createHash("sha256").update(seenBody, "utf8").digest("hex");
    const canonical = buildSignaturePayload({
      method: "POST",
      path: "/v1/coverage/register",
      timestampMs: ts,
      nonce,
      bodyHash,
    });
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(canonical),
      bs58.decode(seenHeaders["x-pact-signature"]),
      KP.publicKey.toBytes(),
    );
    expect(ok).toBe(true);

    // The body is exactly the payload JSON.
    expect(JSON.parse(seenBody)).toEqual(JSON.parse(JSON.stringify(PAYLOAD)));

    // The decision is parsed through.
    expect(decision.status).toBe("settlement_pending");
    expect(decision.coverageId).toBe("cov_abc");
    expect(decision.premiumBaseUnits).toBe("1000");
    expect(decision.refundBaseUnits).toBe("0");
    expect(decision.callId).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("registerCoverage: response handling", () => {
  test("uncovered → status uncovered with reason", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() =>
        jsonResponse(200, { status: "uncovered", reason: "no_allowance", premiumBaseUnits: "0", refundBaseUnits: "0" }),
      ),
    });
    expect(d.status).toBe("uncovered");
    expect(d.reason).toBe("no_allowance");
    expect(d.premiumBaseUnits).toBe("0");
    expect(d.coverageId).toBeNull();
  });

  test("legacy {covered:false,reason} shape → uncovered", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => jsonResponse(200, { covered: false, reason: "no_pool_for_payee" })),
    });
    expect(d.status).toBe("uncovered");
    expect(d.reason).toBe("no_pool_for_payee");
  });

  test("legacy {covered:true,settlement_pending:true} shape → settlement_pending", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() =>
        jsonResponse(200, {
          covered: true,
          settlement_pending: true,
          coverage_id: "cov_x",
          premium_base_units: "1000",
          refund_base_units: "10000",
        }),
      ),
    });
    expect(d.status).toBe("settlement_pending");
    expect(d.coverageId).toBe("cov_x");
    expect(d.premiumBaseUnits).toBe("1000");
    expect(d.refundBaseUnits).toBe("10000");
  });

  test("rejected → status rejected", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => jsonResponse(422, { status: "rejected", reason: "receipt_unverifiable" })),
    });
    expect(d.status).toBe("rejected");
    expect(d.reason).toBe("receipt_unverifiable");
  });

  test("4xx with non-JSON body → rejected", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => new Response("bad request", { status: 400 })),
    });
    expect(d.status).toBe("rejected");
  });

  test("5xx → facilitator_unreachable (graceful degrade)", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => new Response("oops", { status: 503 })),
    });
    expect(d.status).toBe("facilitator_unreachable");
    expect(d.premiumBaseUnits).toBe("0");
    expect(d.refundBaseUnits).toBe("0");
  });

  test("fetch throws (network down) → facilitator_unreachable, never throws", async () => {
    const d = await registerCoverage({
      keypair: KP,
      project: "p",
      payload: PAYLOAD,
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(d.status).toBe("facilitator_unreachable");
    expect(d.reason).toContain("ECONNREFUSED");
  });
});

describe("resolveFacilitatorUrl", () => {
  test("defaults to https://facilitator.pactnetwork.io", () => {
    const saved = process.env.PACT_FACILITATOR_URL;
    delete process.env.PACT_FACILITATOR_URL;
    try {
      expect(resolveFacilitatorUrl()).toBe(DEFAULT_FACILITATOR_URL);
      expect(DEFAULT_FACILITATOR_URL).toBe("https://facilitator.pactnetwork.io");
    } finally {
      if (saved !== undefined) process.env.PACT_FACILITATOR_URL = saved;
    }
  });

  test("honours PACT_FACILITATOR_URL override", () => {
    const saved = process.env.PACT_FACILITATOR_URL;
    process.env.PACT_FACILITATOR_URL = "https://facilitator.staging.test";
    try {
      expect(resolveFacilitatorUrl()).toBe("https://facilitator.staging.test");
    } finally {
      if (saved !== undefined) process.env.PACT_FACILITATOR_URL = saved;
      else delete process.env.PACT_FACILITATOR_URL;
    }
  });
});

describe("getCoverageStatus", () => {
  test("ok → extracts coverage status + settle_batch signature + solscan-able sig", async () => {
    const r = await getCoverageStatus({
      coverageId: "cov_abc",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe("https://f.test/v1/coverage/cov_abc");
        return jsonResponse(200, {
          coverageId: "cov_abc",
          status: "settled",
          callId: "00000000-0000-4000-8000-000000000001",
          settleBatchSignature: "3xQ".repeat(20),
        });
      }),
    });
    expect(r.status).toBe("ok");
    expect(r.coverageStatus).toBe("settled");
    expect(r.callId).toBe("00000000-0000-4000-8000-000000000001");
    expect(r.settleBatchSignature).toBe("3xQ".repeat(20));
    expect(r.body).toEqual({
      coverageId: "cov_abc",
      status: "settled",
      callId: "00000000-0000-4000-8000-000000000001",
      settleBatchSignature: "3xQ".repeat(20),
    });
  });

  test("404 → not_found", async () => {
    const r = await getCoverageStatus({
      coverageId: "missing",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })),
    });
    expect(r.status).toBe("not_found");
  });

  test("5xx → server_error", async () => {
    const r = await getCoverageStatus({
      coverageId: "x",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => new Response("boom", { status: 502 })),
    });
    expect(r.status).toBe("server_error");
  });

  test("network throw → unreachable", async () => {
    const r = await getCoverageStatus({
      coverageId: "x",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => {
        throw new Error("ETIMEDOUT");
      }),
    });
    expect(r.status).toBe("unreachable");
    expect(r.error).toContain("ETIMEDOUT");
  });
});
