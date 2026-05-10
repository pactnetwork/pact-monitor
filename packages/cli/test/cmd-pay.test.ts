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
  const originalGate = process.env.PACT_MAINNET_ENABLED;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-pay-cmd-test-"));
    // pay's mainnet-only gate fires at command entry; tests for the
    // happy/curl-passthrough paths exercise the post-gate logic, so open it.
    // The negative case lives in pay-mainnet-gate.test.ts.
    process.env.PACT_MAINNET_ENABLED = "1";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalGate === undefined) delete process.env.PACT_MAINNET_ENABLED;
    else process.env.PACT_MAINNET_ENABLED = originalGate;
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

  test("unsupported tool returns unsupported_tool envelope (non-zero exit)", async () => {
    const result = await payCommand({
      tool: "wget",
      args: ["https://example.com"],
      configDir: dir,
    });
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      // unsupported_tool is its own status (exit 50) so shell chains stop;
      // see envelope.test.ts for the exit-code mapping.
      expect(result.envelope.status).toBe("unsupported_tool");
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

  // P1 audit fix: --json passthrough must always emit a JSON envelope so
  // pipelines like `pact --json pay curl … | jq` never receive raw bytes,
  // including the no-402 path. Drive `bun run src/index.ts` as a subprocess
  // because the action handler calls process.exit. We use async Bun.spawn —
  // sync spawn would block this runtime's event loop and the in-test Hono
  // server could never respond to the subprocess's curl call (deadlock).
  describe("--json passthrough envelope (P1 audit fix)", () => {
    const CLI_DIR = join(import.meta.dir, "..");

    async function runCli(
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const cliDir = mkdtempSync(join(tmpdir(), "pact-cmd-pay-cli-"));
      try {
        const proc = Bun.spawn({
          cmd: ["bun", "run", "src/index.ts", ...args],
          cwd: CLI_DIR,
          env: {
            ...process.env,
            PACT_MAINNET_ENABLED: "1",
            HOME: cliDir,
            XDG_CONFIG_HOME: cliDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      } finally {
        rmSync(cliDir, { recursive: true, force: true });
      }
    }

    test("2xx no-402 emits an envelope with status=ok and body.payment.kind=none", async () => {
      const app = new Hono();
      app.get("/zen", (c) => c.text("Half measures are as bad as nothing."));
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      try {
        const { stdout, stderr, exitCode } = await runCli([
          "--json",
          "--project",
          "audit-test",
          "pay",
          "curl",
          "-s",
          `http://127.0.0.1:${server.port}/zen`,
        ]);
        let env: {
          status: string;
          body: {
            tool_exit_code: number;
            response_body: string;
            payment: { kind: string };
          };
        };
        try {
          env = JSON.parse(stdout.trim());
        } catch {
          throw new Error(
            `expected JSON envelope, got raw stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
          );
        }
        expect(env.status).toBe("ok");
        expect(env.body.payment.kind).toBe("none");
        expect(env.body.tool_exit_code).toBe(0);
        expect(env.body.response_body).toBe(
          "Half measures are as bad as nothing.",
        );
        expect(exitCode).toBe(0);
      } finally {
        server.stop();
      }
    });

    test("non-zero wrapped-tool exit (curl -f on 4xx) propagates through --json", async () => {
      const app = new Hono();
      app.get("/missing", () => new Response("not found", { status: 404 }));
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      try {
        const { stdout, exitCode } = await runCli([
          "--json",
          "--project",
          "audit-test",
          "pay",
          "curl",
          "-sf",
          `http://127.0.0.1:${server.port}/missing`,
        ]);
        const env = JSON.parse(stdout.trim());
        expect(env.status).toBe("ok");
        // curl -f on 4xx exits 22 — passthrough's contract is the wrapped
        // tool's exit code wins, not the envelope-status mapping.
        expect(env.body.tool_exit_code).toBe(22);
        expect(env.body.payment.kind).toBe("none");
        expect(exitCode).toBe(22);
      } finally {
        server.stop();
      }
    });

    test("non---json case still passes raw bytes through", async () => {
      const app = new Hono();
      app.get("/zen", (c) => c.text("raw passthrough preserved"));
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      try {
        const { stdout, exitCode } = await runCli([
          "--project",
          "audit-test",
          "pay",
          "curl",
          "-s",
          `http://127.0.0.1:${server.port}/zen`,
        ]);
        // Without --json, stdout is the wrapped tool's raw output — nothing
        // JSON-shaped, exactly the bytes curl produced.
        expect(stdout).toBe("raw passthrough preserved");
        expect(exitCode).toBe(0);
      } finally {
        server.stop();
      }
    });
  });

  // Codex review on PR #131: pact pay wget … must exit 50 even when the
  // mainnet gate is closed, because shell chains like `pact pay wgett &&
  // next-step` should stop on a typo regardless of PACT_MAINNET_ENABLED.
  // Pre-fix, payCommand() ran gateEnvelope() before SUPPORTED_TOOLS, so
  // unsupported_tool only fired when mainnet was already enabled.
  describe("unsupported_tool gating order (codex review on PR #131)", () => {
    const CLI_DIR = join(import.meta.dir, "..");

    async function runCliClosedGate(
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const cliDir = mkdtempSync(join(tmpdir(), "pact-cmd-pay-cli-closed-"));
      try {
        // Strip PACT_MAINNET_ENABLED from the inherited env so the gate is
        // closed by default — exactly the production-default state codex
        // reproduced.
        const { PACT_MAINNET_ENABLED: _drop, ...envWithoutGate } = process.env;
        const proc = Bun.spawn({
          cmd: ["bun", "run", "src/index.ts", ...args],
          cwd: CLI_DIR,
          env: {
            ...envWithoutGate,
            HOME: cliDir,
            XDG_CONFIG_HOME: cliDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      } finally {
        rmSync(cliDir, { recursive: true, force: true });
      }
    }

    test("pact pay wget exits 50 with unsupported_tool even when mainnet gate is closed", async () => {
      const { stdout, exitCode } = await runCliClosedGate([
        "--json",
        "--project",
        "audit-test",
        "pay",
        "wget",
        "https://example.com",
      ]);
      const env = JSON.parse(stdout.trim()) as {
        status: string;
        body: { error: string; tool: string };
      };
      expect(env.status).toBe("unsupported_tool");
      expect(env.body.error).toBe("unsupported_tool");
      expect(env.body.tool).toBe("wget");
      expect(exitCode).toBe(50);
    });

    test("pact pay curl with closed gate still returns the gate envelope (gate fires after tool validation)", async () => {
      // Closed gate + supported tool → gate fires, exit code is 0 (gate
      // envelope status is client_error which deliberately maps to 0 to
      // preserve the rest of the CLI's envelope-first contract).
      const { stdout, exitCode } = await runCliClosedGate([
        "--json",
        "--project",
        "audit-test",
        "pay",
        "curl",
        "https://example.com",
      ]);
      const env = JSON.parse(stdout.trim()) as {
        status: string;
        body: { error: string };
      };
      expect(env.status).toBe("client_error");
      expect(env.body.error).toContain("PACT_MAINNET_ENABLED");
      expect(exitCode).toBe(0);
    });
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
