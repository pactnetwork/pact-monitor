import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { callsShowCommand } from "../src/cmd/calls.ts";

const VALID_CALL_ID = "11111111-2222-4333-8444-555555555555";

describe("cmd/calls show", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(() => {
    const app = new Hono();
    app.get("/v1/calls/:id", (c) => {
      const id = c.req.param("id");
      if (id === VALID_CALL_ID) {
        return c.json({
          callId: id,
          agentPubkey: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
          endpointSlug: "helius",
          premiumLamports: "100",
          refundLamports: "0",
          latencyMs: 119,
          breach: false,
          breachReason: null,
          source: "market-proxy",
          ts: "2026-05-10T15:00:00.000Z",
          settledAt: "2026-05-10T15:00:08.000Z",
          signature: "5q4hUBva2kmKTJgHk",
          recipientShares: [],
        });
      }
      return c.json({ error: "call not found" }, 404);
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = server.port!;
  });

  afterEach(() => {
    server.stop();
  });

  test("returns ok envelope for a known call_id", async () => {
    const env = await callsShowCommand({
      gatewayUrl: `http://localhost:${port}`,
      callId: VALID_CALL_ID,
    });
    expect(env.status).toBe("ok");
    const body = env.body as { callId: string; latencyMs: number };
    expect(body.callId).toBe(VALID_CALL_ID);
    expect(body.latencyMs).toBe(119);
  });

  test("returns client_error envelope for an unknown call_id (404)", async () => {
    const env = await callsShowCommand({
      gatewayUrl: `http://localhost:${port}`,
      callId: "22222222-3333-4333-8444-555555555555",
    });
    expect(env.status).toBe("client_error");
    const body = env.body as { http_status: number };
    expect(body.http_status).toBe(404);
  });

  test("rejects malformed call_id locally without a network round-trip", async () => {
    // Wrong server URL — if the validator misses, the fetch fails noisily.
    const env = await callsShowCommand({
      gatewayUrl: "http://localhost:1",
      callId: "not-a-uuid",
    });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toBe("invalid_call_id");
  });

  test("rejects a wallet-shaped pubkey as a call_id", async () => {
    const env = await callsShowCommand({
      gatewayUrl: "http://localhost:1",
      callId: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
    });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string; message: string };
    expect(body.error).toBe("invalid_call_id");
    expect(body.message).toContain("pact agents show");
  });
});
