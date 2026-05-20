import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { earningsCommand } from "../src/cmd/earnings.ts";

const PUBKEY = "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1";

describe("cmd/earnings", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeEach(() => {
    const app = new Hono();
    app.get("/api/recipients/:pubkey", (c) => {
      const pk = c.req.param("pubkey");
      if (pk === PUBKEY) {
        return c.json({
          recipientPubkey: PUBKEY,
          recipientKind: 1,
          lifetimeEarnedLamports: "12345",
          lastUpdated: "2026-05-20T00:00:00.000Z",
        });
      }
      return c.json({
        recipientPubkey: pk,
        recipientKind: null,
        lifetimeEarnedLamports: "0",
        lastUpdated: null,
      });
    });
    app.get("/api/recipients/:pubkey/settlements", (c) => {
      return c.json({
        items: [
          {
            id: "ck1",
            settledAt: "2026-05-20T00:00:00.000Z",
            txSignature: "sig1",
            amountLamports: "100",
            recipientKind: 1,
          },
        ],
        nextCursor: null,
      });
    });
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://localhost:${server.port!}`;
  });

  afterEach(() => server.stop());

  test("ok envelope for a populated recipient (lifetime only)", async () => {
    const env = await earningsCommand({
      pubkey: PUBKEY,
      history: false,
      indexerBaseUrl: baseUrl,
    });
    expect(env.status).toBe("ok");
    const body = env.body as {
      action: string;
      affiliate: string;
      lifetime: { lifetime_earned_lamports: string; recipient_kind: number | null };
      history?: unknown;
    };
    expect(body.action).toBe("earnings");
    expect(body.affiliate).toBe(PUBKEY);
    expect(body.lifetime.lifetime_earned_lamports).toBe("12345");
    expect(body.lifetime.recipient_kind).toBe(1);
    expect(body.history).toBeUndefined();
  });

  test("ok envelope with --history includes paginated items", async () => {
    const env = await earningsCommand({
      pubkey: PUBKEY,
      history: true,
      indexerBaseUrl: baseUrl,
    });
    expect(env.status).toBe("ok");
    const body = env.body as {
      history: { items: { txSignature: string }[]; next_cursor: string | null };
    };
    expect(body.history.items).toHaveLength(1);
    expect(body.history.items[0].txSignature).toBe("sig1");
    expect(body.history.next_cursor).toBeNull();
  });

  test("ok envelope with zero values for an unknown pubkey (200 zero envelope)", async () => {
    const unknown = "ZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZzZz";
    const env = await earningsCommand({
      pubkey: unknown,
      history: false,
      indexerBaseUrl: baseUrl,
    });
    expect(env.status).toBe("ok");
    const body = env.body as { lifetime: { lifetime_earned_lamports: string } };
    expect(body.lifetime.lifetime_earned_lamports).toBe("0");
  });

  test("indexer_unreachable envelope when indexer returns 500", async () => {
    const downApp = new Hono();
    downApp.get("/api/recipients/:pubkey", (c) => c.text("oops", 500));
    const downServer = Bun.serve({ port: 0, fetch: downApp.fetch });
    try {
      const env = await earningsCommand({
        pubkey: PUBKEY,
        history: false,
        indexerBaseUrl: `http://localhost:${downServer.port!}`,
      });
      expect(env.status).toBe("indexer_unreachable");
    } finally {
      downServer.stop();
    }
  });

  test("client_error envelope on malformed pubkey", async () => {
    const env = await earningsCommand({
      pubkey: "not-a-pubkey",
      history: false,
      indexerBaseUrl: baseUrl,
    });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toBe("invalid_pubkey");
  });
});
