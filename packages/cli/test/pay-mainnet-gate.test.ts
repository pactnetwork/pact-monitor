import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { payCommand } from "../src/cmd/pay.ts";
import {
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_V2,
} from "../src/lib/x402.ts";
import {
  HEADER_AUTHORIZATION,
  HEADER_WWW_AUTHENTICATE,
  SCHEME_SOLANA_CHARGE,
} from "../src/lib/mpp.ts";

// Defense-in-depth coverage for Rick's PR #64 blocker: pact pay must short-
// circuit to a client_error envelope when PACT_MAINNET_ENABLED is unset, so
// the wrapped tool never spawns and no signing path can be reached. The check
// lives at the top of payCommand AND inside handleX402Retry/handleMppRetry,
// so a future refactor that bypasses the entry-point check still trips the
// retry-handler check.

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

const X402_REQS = {
  scheme: "exact",
  network: "solana",
  maxAmountRequired: "10000",
  resource: "/v1/quote/AAPL",
  description: "AAPL quote",
  payTo: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

describe("cmd/pay — PACT_MAINNET_ENABLED gate", () => {
  let dir: string;
  const originalGate = process.env.PACT_MAINNET_ENABLED;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-pay-gate-test-"));
    delete process.env.PACT_MAINNET_ENABLED;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalGate === undefined) delete process.env.PACT_MAINNET_ENABLED;
    else process.env.PACT_MAINNET_ENABLED = originalGate;
  });

  test("non-402 passthrough: gate blocks before curl spawns", async () => {
    // Bug repro from PR #64 review: `pact pay curl https://httpbin.org/status/200`
    // returned 200 because pay never checked the gate before spawning curl.
    // Use a sentinel spawn that throws if invoked; the gate must short-circuit
    // before any spawn happens.
    const result = await payCommand({
      tool: "curl",
      args: ["-s", "https://example.com"],
      configDir: dir,
      spawn: () => {
        throw new Error("spawn must not be reached when gate is closed");
      },
    });
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      expect(result.envelope.status).toBe("client_error");
      const b = result.envelope.body as { error: string };
      expect(b.error).toContain("PACT_MAINNET_ENABLED");
      expect(b.error).toContain("mainnet-only");
    }
  });

  test("x402 retry: gate blocks signing path", async () => {
    // Belt-and-suspenders: even if a future refactor moved the entry-point
    // gate, the retry handler must independently refuse to sign.
    const app = new Hono();
    app.get("/v1/quote/:sym", (c) => {
      const paid = c.req.header(HEADER_PAYMENT_V2);
      if (!paid) {
        const env = { x402Version: 2, accepts: [X402_REQS] };
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            [HEADER_PAYMENT_REQUIRED_V2]: b64(env),
          },
        });
      }
      return c.json({ ok: true });
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `http://127.0.0.1:${server.port}/v1/quote/AAPL`],
        configDir: dir,
      });
      expect(result.kind).toBe("envelope");
      if (result.kind === "envelope") {
        expect(result.envelope.status).toBe("client_error");
        const b = result.envelope.body as { error: string };
        expect(b.error).toContain("PACT_MAINNET_ENABLED");
      }
    } finally {
      server.stop();
    }
  });

  test("mpp retry: gate blocks signing path", async () => {
    const app = new Hono();
    app.get("/v1/quote/:sym", (c) => {
      const auth = c.req.header(HEADER_AUTHORIZATION);
      if (!auth || !auth.startsWith(`${SCHEME_SOLANA_CHARGE} `)) {
        const charge = b64({
          amount: "10000",
          currency: "USDC",
          recipient: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
          description: "AAPL quote",
          method_details: { network: "solana" },
        });
        return new Response("{}", {
          status: 402,
          headers: {
            "content-type": "application/json",
            [HEADER_WWW_AUTHENTICATE]: `${SCHEME_SOLANA_CHARGE} realm="api", charge="${charge}"`,
          },
        });
      }
      return c.json({ ok: true });
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `http://127.0.0.1:${server.port}/v1/quote/AAPL`],
        configDir: dir,
      });
      expect(result.kind).toBe("envelope");
      if (result.kind === "envelope") {
        expect(result.envelope.status).toBe("client_error");
        const b = result.envelope.body as { error: string };
        expect(b.error).toContain("PACT_MAINNET_ENABLED");
      }
    } finally {
      server.stop();
    }
  });

  test("happy path with gate open still works (smoke)", async () => {
    process.env.PACT_MAINNET_ENABLED = "1";
    const app = new Hono();
    app.get("/healthz", (c) => c.text("ok"));
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `http://127.0.0.1:${server.port}/healthz`],
        configDir: dir,
      });
      expect(result.kind).toBe("passthrough");
      if (result.kind === "passthrough") {
        expect(result.exitCode).toBe(0);
        expect(new TextDecoder().decode(result.bodyBytes)).toBe("ok");
      }
    } finally {
      server.stop();
    }
  });
});
