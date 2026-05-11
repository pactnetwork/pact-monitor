// pact pay tests for the 0.2.0 pay.sh-wrapper rewrite.
//
// The new pact pay spawns `pay <args>` instead of running curl directly.
// Tests inject a `PayShellFn` so we never touch the real pay binary;
// each test feeds a deterministic stdout/stderr/exit-code triple to
// drive the classifier through every branch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { payCommand } from "../src/cmd/pay.ts";
import type { PayShellFn } from "../src/lib/pay-shell.ts";
import {
  classifyPayResult,
  type Outcome,
} from "../src/lib/pay-classifier.ts";

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

function fakePay(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): PayShellFn {
  return async () => ({
    exitCode: opts.exitCode ?? 0,
    stdout: enc(opts.stdout ?? ""),
    stderr: enc(opts.stderr ?? ""),
  });
}

class BufStream {
  parts: string[] = [];
  write(s: string) {
    this.parts.push(s);
    return true;
  }
  get text() {
    return this.parts.join("");
  }
}

// Common stderr templates that mirror real pay.sh verbose output
// (verified vs solana-foundation/pay rust/crates/cli/src/commands/mod.rs
// 2026-05-05).
const PAY_VERBOSE_SUCCESS =
  "402 Payment Required (x402) — 0.05 USDC\n" +
  "Paying...\n" +
  "Payment signed, retrying...\n";
const PAY_VERBOSE_PAYMENT_FAILED =
  "402 Payment Required (x402) — 0.05 USDC\n" +
  "Paying...\n" +
  "Payment failed: insufficient balance\n";

// ----------------------------------------------------------------------
// Mainnet gate (defense-in-depth)
// ----------------------------------------------------------------------

describe("pact pay: mainnet gate", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.PACT_MAINNET_ENABLED;
    delete process.env.PACT_MAINNET_ENABLED;
  });
  afterEach(() => {
    if (savedEnv !== undefined) process.env.PACT_MAINNET_ENABLED = savedEnv;
    else delete process.env.PACT_MAINNET_ENABLED;
  });

  test("closed gate short-circuits to client_error before spawning pay", async () => {
    let spawned = false;
    const result = await payCommand({
      args: ["curl", "https://example.com"],
      pay: async () => {
        spawned = true;
        return { exitCode: 0, stdout: enc(""), stderr: enc("") };
      },
      emitSummary: false,
    });
    expect(spawned).toBe(false);
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      expect(result.envelope.status).toBe("client_error");
      const body = result.envelope.body as { error: string };
      expect(body.error).toContain("PACT_MAINNET_ENABLED");
    }
  });

  for (const flag of ["--sandbox", "--dev", "--local"] as const) {
    test(`closed gate is bypassed when argv contains ${flag} (pay's non-mainnet flag)`, async () => {
      let spawned = false;
      const result = await payCommand({
        args: [flag, "curl", "https://debugger.pay.sh/mpp/quote/AAPL"],
        pay: async () => {
          spawned = true;
          return { exitCode: 0, stdout: enc("status=200"), stderr: enc("") };
        },
        emitSummary: false,
      });
      expect(spawned).toBe(true);
      expect(result.kind).toBe("passthrough");
    });
  }

  test("a non-mainnet flag appearing after `--` does NOT bypass the gate", async () => {
    let spawned = false;
    const result = await payCommand({
      args: ["curl", "--", "--sandbox", "https://example.com"],
      pay: async () => {
        spawned = true;
        return { exitCode: 0, stdout: enc(""), stderr: enc("") };
      },
      emitSummary: false,
    });
    expect(spawned).toBe(false);
    expect(result.kind).toBe("envelope");
  });
});

// ----------------------------------------------------------------------
// Arg validation
// ----------------------------------------------------------------------

describe("pact pay: arg validation", () => {
  test("empty args returns missing_args envelope without spawning pay", async () => {
    let spawned = false;
    const result = await payCommand({
      args: [],
      pay: async () => {
        spawned = true;
        return { exitCode: 0, stdout: enc(""), stderr: enc("") };
      },
      emitSummary: false,
    });
    expect(spawned).toBe(false);
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      const body = result.envelope.body as { error: string };
      expect(body.error).toBe("missing_args");
    }
  });
});

// ----------------------------------------------------------------------
// Happy passthrough (gate open, pay succeeds, upstream 2xx)
// ----------------------------------------------------------------------

describe("pact pay: passthrough (gate open)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PACT_MAINNET_ENABLED;
    process.env.PACT_MAINNET_ENABLED = "1";
  });
  afterEach(() => {
    if (saved !== undefined) process.env.PACT_MAINNET_ENABLED = saved;
    else delete process.env.PACT_MAINNET_ENABLED;
  });

  test("pay exit 0 + signed payment + 200 stdout hint → success outcome, exit 0", async () => {
    const summary = new BufStream();
    const result = await payCommand({
      args: ["curl", "-s", "-w", "status=%{http_code}", "https://example.com"],
      pay: fakePay({
        exitCode: 0,
        stdout: '{"ok":true} status=200',
        stderr: PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.exitCode).toBe(0);
      expect(result.outcome).toBe("success");
      expect(result.upstreamStatus).toBe(200);
      expect(result.payment.attempted).toBe(true);
      expect(result.payment.signed).toBe(true);
      expect(result.payment.amount).toBe("0.05");
      expect(result.payment.asset).toBe("USDC");
    }
    expect(summary.text).toContain("[pact] classifier: success");
    expect(summary.text).not.toContain("refund");
  });

  test("pay exit 0 but upstream 503 → server_error outcome + refund-policy line", async () => {
    const summary = new BufStream();
    const result = await payCommand({
      args: ["curl", "-s", "-w", "status=%{http_code}", "https://flaky.example"],
      pay: fakePay({
        exitCode: 0,
        stdout: '{"error":"upstream_timeout"} status=503',
        stderr: PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("server_error");
      expect(result.upstreamStatus).toBe(503);
    }
    expect(summary.text).toContain("classifier: server_error");
    expect(summary.text).toContain("policy: refund_on_server_error");
    expect(summary.text).toContain("facilitator.pact.network");
  });

  test("upstream 422 → client_error outcome, no refund offered", async () => {
    const summary = new BufStream();
    const result = await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://example.com/bad"],
      pay: fakePay({
        exitCode: 0,
        stdout: "bad request status=422",
        stderr: PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("client_error");
      expect(result.upstreamStatus).toBe(422);
    }
    expect(summary.text).toContain("classifier: client_error");
    expect(summary.text).toContain("no refund");
  });

  test("payment leg failure → payment_failed, no charge line", async () => {
    const summary = new BufStream();
    const result = await payCommand({
      args: ["curl", "https://example.com"],
      pay: fakePay({
        exitCode: 1,
        stdout: "",
        stderr: PAY_VERBOSE_PAYMENT_FAILED,
      }),
      summaryStream: summary,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("payment_failed");
      expect(result.payment.signed).toBe(false);
    }
    expect(summary.text).toContain("classifier: payment_failed");
    expect(summary.text).toContain("no charge");
  });

  test("pay exit 0, no x402 challenge (free upstream) → success, attempted=false", async () => {
    const summary = new BufStream();
    const result = await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://api.github.com/zen"],
      pay: fakePay({
        exitCode: 0,
        stdout: "Half measures are as bad as nothing. status=200",
        stderr: "",
      }),
      summaryStream: summary,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("success");
      expect(result.payment.attempted).toBe(false);
    }
    expect(summary.text).not.toContain("premium");
    expect(summary.text).toContain("classifier: success");
  });

  test("pay binary not on PATH surfaces tool_missing envelope", async () => {
    const result = await payCommand({
      args: ["curl", "https://example.com"],
      pay: async () => {
        throw new Error("ENOENT: spawn pay");
      },
      emitSummary: false,
    });
    expect(result.kind).toBe("envelope");
    if (result.kind === "envelope") {
      expect(result.envelope.status).toBe("tool_missing");
      const body = result.envelope.body as {
        error: string;
        tool: string;
        suggest: string;
      };
      expect(body.error).toBe("pay_unavailable");
      expect(body.tool).toBe("pay");
      expect(body.suggest).toContain("solana-foundation/pay");
    }
  });

  test("emitSummary=false suppresses the [pact] summary block", async () => {
    const summary = new BufStream();
    await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://example.com"],
      pay: fakePay({
        exitCode: 0,
        stdout: "{} status=200",
        stderr: PAY_VERBOSE_SUCCESS,
      }),
      emitSummary: false,
      summaryStream: summary,
    });
    expect(summary.text).toBe("");
  });
});

// ----------------------------------------------------------------------
// Classifier unit tests — isolated, no command shell
// ----------------------------------------------------------------------

describe("classifyPayResult", () => {
  const cases: Array<{
    name: string;
    payExitCode: number;
    stdoutText: string;
    stderrText: string;
    expect: Outcome;
  }> = [
    {
      name: "2xx + signed → success",
      payExitCode: 0,
      stdoutText: "status=200",
      stderrText: PAY_VERBOSE_SUCCESS,
      expect: "success",
    },
    {
      name: "5xx + signed → server_error",
      payExitCode: 0,
      stdoutText: "status=503",
      stderrText: PAY_VERBOSE_SUCCESS,
      expect: "server_error",
    },
    {
      name: "4xx + signed → client_error",
      payExitCode: 0,
      stdoutText: "status=404",
      stderrText: PAY_VERBOSE_SUCCESS,
      expect: "client_error",
    },
    {
      name: "explicit Payment failed → payment_failed",
      payExitCode: 1,
      stdoutText: "",
      stderrText: PAY_VERBOSE_PAYMENT_FAILED,
      expect: "payment_failed",
    },
    {
      name: "signed + non-zero exit + no status hint → server_error (bias)",
      payExitCode: 7,
      stdoutText: "",
      stderrText: PAY_VERBOSE_SUCCESS,
      expect: "server_error",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const r = classifyPayResult({
        payExitCode: c.payExitCode,
        stdoutText: c.stdoutText,
        stderrText: c.stderrText,
      });
      expect(r.outcome).toBe(c.expect);
    });
  }
});
