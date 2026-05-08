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
import {
  decodeEnvelope,
  verifyEnvelopeSignature,
  PACT_PAYMENT_SCHEME,
} from "../src/lib/pay-auth.ts";

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

interface CallLog {
  unauthenticated: number;
  paid: number;
  lastPaymentHeader?: string;
  lastAuthHeader?: string;
}

function startX402Mock(port = 0): {
  url: string;
  log: CallLog;
  stop: () => void;
} {
  const log: CallLog = { unauthenticated: 0, paid: 0 };
  const app = new Hono();
  app.get("/v1/quote/:sym", (c) => {
    const paymentHeader = c.req.header(HEADER_PAYMENT_V2);
    if (!paymentHeader) {
      log.unauthenticated++;
      const env = { x402Version: 2, accepts: [X402_REQS] };
      const body = JSON.stringify({ error: "payment_required" });
      return new Response(body, {
        status: 402,
        headers: {
          "content-type": "application/json",
          [HEADER_PAYMENT_REQUIRED_V2]: b64(env),
        },
      });
    }
    log.paid++;
    log.lastPaymentHeader = paymentHeader;
    return c.json({ ok: true, sym: c.req.param("sym"), price: "200.00" });
  });
  const server = Bun.serve({ port, fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    log,
    stop: () => server.stop(),
  };
}

function startMppMock(port = 0): {
  url: string;
  log: CallLog;
  stop: () => void;
} {
  const log: CallLog = { unauthenticated: 0, paid: 0 };
  const app = new Hono();
  app.get("/v1/quote/:sym", (c) => {
    const auth = c.req.header(HEADER_AUTHORIZATION);
    if (!auth || !auth.startsWith(`${SCHEME_SOLANA_CHARGE} `)) {
      log.unauthenticated++;
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
    log.paid++;
    log.lastAuthHeader = auth;
    return c.json({ ok: true, sym: c.req.param("sym") });
  });
  const server = Bun.serve({ port, fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    log,
    stop: () => server.stop(),
  };
}

describe("cmd/pay — end-to-end with real curl + mock upstream", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-pay-cmd-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("happy path: x402 challenge → signed retry → 200", async () => {
    const mock = startX402Mock();
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `${mock.url}/v1/quote/AAPL`],
        configDir: dir,
      });
      expect(result.kind).toBe("passthrough");
      if (result.kind === "passthrough") {
        expect(result.exitCode).toBe(0);
        const body = new TextDecoder().decode(result.bodyBytes);
        const parsed = JSON.parse(body);
        expect(parsed.ok).toBe(true);
        expect(parsed.sym).toBe("AAPL");
        // payment metadata threaded through so --json can wrap into an
        // x402_payment_made envelope at the index.ts layer.
        expect(result.payment.kind).toBe("x402");
        if (result.payment.kind === "x402") {
          expect(result.payment.recipient).toBe(X402_REQS.payTo);
          expect(result.payment.amount).toBe(X402_REQS.maxAmountRequired);
          expect(result.payment.network).toBe("solana");
        }
      }
      expect(mock.log.unauthenticated).toBe(1);
      expect(mock.log.paid).toBe(1);

      // Verify the X-PAYMENT header carried a well-formed pact-allowance
      // envelope with a valid signature — round-trip integrity check.
      const envelope = decodeEnvelope(mock.log.lastPaymentHeader!) as {
        scheme: string;
        payload: { resource: string; recipient: string; amount: string };
      };
      expect(envelope.scheme).toBe(PACT_PAYMENT_SCHEME);
      expect(envelope.payload.recipient).toBe(X402_REQS.payTo);
      expect(envelope.payload.amount).toBe(X402_REQS.maxAmountRequired);
      expect(verifyEnvelopeSignature(envelope as never)).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("happy path: MPP challenge → signed credential retry → 200", async () => {
    const mock = startMppMock();
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `${mock.url}/v1/quote/AAPL`],
        configDir: dir,
      });
      expect(result.kind).toBe("passthrough");
      if (result.kind === "passthrough") {
        expect(result.exitCode).toBe(0);
        expect(result.payment.kind).toBe("mpp");
      }
      expect(mock.log.unauthenticated).toBe(1);
      expect(mock.log.paid).toBe(1);
      expect(mock.log.lastAuthHeader).toMatch(
        /^SolanaCharge credential="[A-Za-z0-9+/=]+"$/,
      );
    } finally {
      mock.stop();
    }
  });

  test("non-402 response passes through with original exit code", async () => {
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
        // No 402 → payment metadata is "none"; --json stays transparent.
        expect(result.payment.kind).toBe("none");
      }
    } finally {
      server.stop();
    }
  });

  test("unsupported tool returns client_error envelope", async () => {
    const result = await payCommand({
      tool: "wget",
      args: ["https://example.com"],
      configDir: dir,
    });
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      expect(result.envelope.status).toBe("client_error");
      const b = result.envelope.body as { error: string; tool: string };
      expect(b.error).toBe("unsupported_tool");
      expect(b.tool).toBe("wget");
    }
  });

  test("unknown 402 (no challenge headers) surfaces unknown_402 envelope", async () => {
    const app = new Hono();
    app.all("*", () => new Response("nope", { status: 402 }));
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `http://127.0.0.1:${server.port}/x`],
        configDir: dir,
      });
      expect(result.kind).toBe("envelope");
      if (result.kind === "envelope") {
        expect(result.envelope.status).toBe("client_error");
        expect((result.envelope.body as { error: string }).error).toBe(
          "unknown_402",
        );
      }
    } finally {
      server.stop();
    }
  });

  test("payment rejection body surfaces payment_rejected envelope", async () => {
    const app = new Hono();
    app.all("*", () =>
      new Response(
        JSON.stringify({ error: "verification_failed", reason: "expired" }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const result = await payCommand({
        tool: "curl",
        args: ["-s", `http://127.0.0.1:${server.port}/x`],
        configDir: dir,
      });
      expect(result.kind).toBe("envelope");
      if (result.kind === "envelope") {
        const b = result.envelope.body as { error: string; reason: string };
        expect(b.error).toBe("payment_rejected");
        expect(b.reason).toBe("expired");
      }
    } finally {
      server.stop();
    }
  });
});
