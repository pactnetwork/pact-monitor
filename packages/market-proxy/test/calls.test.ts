// Verifies /v1/calls/:id — the gateway route the CLI's `pact calls show`
// command hits to fetch a single call's details. Wire shape mirrors the
// indexer's CallsController so dashboards and CLIs that consume one can
// consume the other unchanged.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { callsRoute } from "../src/routes/calls.js";

const VALID_CALL_ID = "11111111-2222-4333-8444-555555555555";
const SAMPLE_SIG = "5q4hUBva2kmKTJgHkAMQs4JjzpHyJp4DZRiPxden4YzxjBmcJXfLiTjrxZkFJZigXkLBU68c9f2HPTFM7NBZxcJk";

const sampleRow = {
  callId: VALID_CALL_ID,
  agentPubkey: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
  endpointSlug: "helius",
  premiumLamports: 100n,
  refundLamports: 0n,
  latencyMs: 119,
  breach: false,
  breachReason: null,
  source: "market-proxy",
  ts: new Date("2026-05-10T15:00:00Z"),
  settledAt: new Date("2026-05-10T15:00:08Z"),
  signature: SAMPLE_SIG,
};

const sampleShare = {
  recipientKind: 0,
  recipientPubkey: "TreasuryPubkey1111111111111111111111111111",
  amountLamports: 50n,
};

const mockPg = { query: vi.fn() };

vi.mock("../src/lib/context.js", () => ({
  getContext: () => ({ pg: mockPg }),
  initContext: vi.fn(),
  setContext: vi.fn(),
}));

function buildApp() {
  const app = new Hono();
  app.get("/v1/calls/:id", callsRoute);
  return app;
}

describe("/v1/calls/:id", () => {
  beforeEach(() => {
    mockPg.query.mockReset();
  });

  test("returns CallWire shape with recipientShares", async () => {
    mockPg.query
      .mockResolvedValueOnce({ rows: [sampleRow] })
      .mockResolvedValueOnce({ rows: [sampleShare] });

    const app = buildApp();
    const res = await app.request(`/v1/calls/${VALID_CALL_ID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.callId).toBe(VALID_CALL_ID);
    expect(body.agentPubkey).toBe(sampleRow.agentPubkey);
    expect(body.endpointSlug).toBe("helius");
    expect(body.premiumLamports).toBe("100");
    expect(body.refundLamports).toBe("0");
    expect(body.latencyMs).toBe(119);
    expect(body.breach).toBe(false);
    expect(body.signature).toBe(SAMPLE_SIG);
    expect(body.ts).toBe("2026-05-10T15:00:00.000Z");
    expect(body.settledAt).toBe("2026-05-10T15:00:08.000Z");
    expect(body.recipientShares).toEqual([
      {
        kind: 0,
        pubkey: sampleShare.recipientPubkey,
        amountLamports: "50",
      },
    ]);
  });

  test("emits empty recipientShares array when no shares exist", async () => {
    mockPg.query
      .mockResolvedValueOnce({ rows: [sampleRow] })
      .mockResolvedValueOnce({ rows: [] });

    const app = buildApp();
    const res = await app.request(`/v1/calls/${VALID_CALL_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recipientShares: unknown[] };
    expect(body.recipientShares).toEqual([]);
  });

  test("returns 404 when callId is unknown", async () => {
    mockPg.query.mockResolvedValueOnce({ rows: [] });

    const app = buildApp();
    const res = await app.request(`/v1/calls/${VALID_CALL_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("call not found");
    // Shape gate must come BEFORE DB load — but a valid-shaped unknown id
    // should reach exactly one query and stop.
    expect(mockPg.query).toHaveBeenCalledTimes(1);
  });

  test("rejects non-UUID inputs with 400 before touching the DB", async () => {
    const app = buildApp();
    // Cases that DO match :id (single path segment, no slashes/dots that
    // re-route). Path-traversal probes like ../etc/passwd never reach the
    // handler because Hono routes them elsewhere — that's defense in depth,
    // and the mockPg assertion below covers it.
    const malformed = [
      "not-a-uuid",
      "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
      "abc",
      // Canonical UUID shape but version=1 (third group starts with 1) —
      // the route now enforces v4.
      "11111111-2222-1333-8444-555555555555",
      // Canonical UUID v4 shape but RFC 4122 variant byte is invalid
      // (fourth group starts with c, not 8/9/a/b).
      "11111111-2222-4333-c444-555555555555",
    ];
    for (const id of malformed) {
      const res = await app.request(`/v1/calls/${id}`);
      expect(res.status, `id=${id}`).toBe(400);
    }
    expect(mockPg.query).not.toHaveBeenCalled();
  });

  test("returns 502 when DB throws", async () => {
    mockPg.query.mockRejectedValueOnce(new Error("connection refused"));
    const app = buildApp();
    const res = await app.request(`/v1/calls/${VALID_CALL_ID}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("failed to read call");
  });

  test("does not leak signature or pubkey on 502", async () => {
    mockPg.query.mockRejectedValueOnce(new Error("boom"));
    const app = buildApp();
    const res = await app.request(`/v1/calls/${VALID_CALL_ID}`);
    const body = (await res.text()) ?? "";
    expect(body).not.toContain(SAMPLE_SIG);
    expect(body).not.toContain(sampleRow.agentPubkey);
  });
});
