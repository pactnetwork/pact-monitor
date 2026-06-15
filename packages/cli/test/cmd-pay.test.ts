// pact pay tests for the 0.2.0 pay.sh-wrapper rewrite.
//
// The new pact pay spawns `pay <args>` instead of running curl directly.
// Tests inject a `PayShellFn` so we never touch the real pay binary;
// each test feeds a deterministic stdout/stderr/exit-code triple to
// drive the classifier through every branch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { payCommand, coverageMeta } from "../src/cmd/pay.ts";
import {
  PACT_CURL_STATUS_WRITE_OUT,
  withCurlStatusMarker,
  type PayShellFn,
} from "../src/lib/pay-shell.ts";
import {
  classifyPayResult,
  type Outcome,
} from "../src/lib/pay-classifier.ts";
import type {
  CoverageDecision,
  RegisterCoverageInput,
} from "../src/lib/facilitator.ts";

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
      // Hermetic: pretend no wallet is resolvable so the breach path
      // emits the "no wallet" note regardless of whether pay.sh is
      // installed on the test runner.
      skipWalletResolution: true,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("server_error");
      expect(result.upstreamStatus).toBe(503);
    }
    expect(summary.text).toContain("classifier: server_error");
    expect(summary.text).toContain("policy: refund_on_server_error");
    // No pact wallet / PACT_PRIVATE_KEY in this test, so the facilitator
    // side-call is skipped — the policy line says so. The covered /
    // breach-with-refund paths are exercised in the
    // "pact pay: facilitator coverage" describe block below with a
    // mocked registerCoverage.
    expect(summary.text).toContain("coverage skipped (no wallet)");
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

  test("wrapped tool exits non-zero with no payment attempted → tool_error outcome (passthrough)", async () => {
    const summary = new BufStream();
    const result = await payCommand({
      args: ["wget", "http://example.com"],
      pay: fakePay({
        exitCode: 1,
        stdout: "",
        stderr: "",
      }),
      summaryStream: summary,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("tool_error");
      expect(result.exitCode).toBe(1);
      expect(result.payment.attempted).toBe(false);
      expect(result.reason).toContain("1");
    }
    expect(summary.text).toContain("classifier: tool_error");
    expect(summary.text).toContain("no charge");
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

  test("first-run probe: no provisioned accounts → warning written and pay still spawned", async () => {
    const summary = new BufStream();
    const probeOrder: string[] = [];
    await payCommand({
      args: ["curl", "https://example.com"],
      probe: async () => {
        probeOrder.push("probe");
        return { initialized: false };
      },
      pay: async () => {
        probeOrder.push("pay");
        return { exitCode: 0, stdout: enc("ok status=200"), stderr: enc("") };
      },
      summaryStream: summary,
    });
    expect(probeOrder).toEqual(["probe", "pay"]);
    expect(summary.text).toContain("pay.sh has not been initialized");
    expect(summary.text).toContain("Touch ID");
    expect(summary.text).toContain("solana-foundation/pay#setup");
  });

  test("first-run probe: initialized host suppresses the warning", async () => {
    const summary = new BufStream();
    await payCommand({
      args: ["curl", "https://example.com"],
      probe: async () => ({ initialized: true }),
      pay: fakePay({
        exitCode: 0,
        stdout: "ok status=200",
        stderr: "",
      }),
      summaryStream: summary,
    });
    expect(summary.text).not.toContain("pay.sh has not been initialized");
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
// Verbose-flag injection (#157)
//
// pay 0.16.0 emits its x402/MPP tracing only when -v is passed. Without
// it the classifier sees empty stderr and reports payment.attempted=false
// even when pay actually settled. pact pay must inject -v before the
// wrapped tool, unless the user explicitly asked for quiet output.
// ----------------------------------------------------------------------

describe("pact pay: verbose-flag injection (#157)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PACT_MAINNET_ENABLED;
    process.env.PACT_MAINNET_ENABLED = "1";
  });
  afterEach(() => {
    if (saved !== undefined) process.env.PACT_MAINNET_ENABLED = saved;
    else delete process.env.PACT_MAINNET_ENABLED;
  });

  function capturingPay(): { fn: PayShellFn; captured: string[][] } {
    const captured: string[][] = [];
    const fn: PayShellFn = async (args) => {
      captured.push(args);
      return { exitCode: 0, stdout: enc(""), stderr: enc("") };
    };
    return { fn, captured };
  }

  test("default invocation prepends -v before wrapped tool", async () => {
    const { fn, captured } = capturingPay();
    await payCommand({
      args: ["curl", "-s", "https://example.com"],
      pay: fn,
      emitSummary: false,
    });
    expect(captured.length).toBe(1);
    expect(captured[0]).toEqual([
      "-v",
      "curl",
      "-s",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });

  test("--quiet at head suppresses injection (passed through to pay)", async () => {
    const { fn, captured } = capturingPay();
    await payCommand({
      args: ["--quiet", "curl", "https://example.com"],
      pay: fn,
      emitSummary: false,
    });
    // -v is suppressed by --quiet, but the curl -w status marker is
    // still appended — the classifier needs the upstream status
    // regardless of pay's own verbosity.
    expect(captured[0]).toEqual([
      "--quiet",
      "curl",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });

  test("-q short form suppresses injection", async () => {
    const { fn, captured } = capturingPay();
    await payCommand({
      args: ["-q", "curl", "https://example.com"],
      pay: fn,
      emitSummary: false,
    });
    expect(captured[0]).toEqual([
      "-q",
      "curl",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });

  test("--silent variant suppresses injection", async () => {
    const { fn, captured } = capturingPay();
    await payCommand({
      args: ["--silent", "curl", "https://example.com"],
      pay: fn,
      emitSummary: false,
    });
    expect(captured[0]).toEqual([
      "--silent",
      "curl",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });

  test("--silent on the wrapped tool (after curl) does NOT suppress -v", async () => {
    // Only pay-side flags (those before the first non-flag arg) opt out.
    // `curl --silent` is a curl flag, not a pact-pay quiet request.
    const { fn, captured } = capturingPay();
    await payCommand({
      args: ["curl", "--silent", "https://example.com"],
      pay: fn,
      emitSummary: false,
    });
    expect(captured[0]).toEqual([
      "-v",
      "curl",
      "--silent",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });
});

// ----------------------------------------------------------------------
// curl -w status-marker injection (SLA-breach refunds via `pact pay curl`)
// ----------------------------------------------------------------------

describe("withCurlStatusMarker", () => {
  test("appends -w status marker for a bare `curl` invocation", () => {
    expect(withCurlStatusMarker(["-v", "curl", "https://example.com"])).toEqual([
      "-v",
      "curl",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });

  test("does NOT inject for wget", () => {
    const argv = ["-v", "wget", "https://example.com"];
    expect(withCurlStatusMarker(argv)).toEqual(argv);
  });

  test("does NOT inject for httpie (`http`)", () => {
    const argv = ["-v", "http", "GET", "https://example.com"];
    expect(withCurlStatusMarker(argv)).toEqual(argv);
  });

  test("does NOT inject for claude / codex", () => {
    expect(withCurlStatusMarker(["-v", "claude", "-p", "hi"])).toEqual([
      "-v",
      "claude",
      "-p",
      "hi",
    ]);
    expect(withCurlStatusMarker(["-v", "codex", "exec", "x"])).toEqual([
      "-v",
      "codex",
      "exec",
      "x",
    ]);
  });

  test("does NOT double-inject when the user already passed -w", () => {
    const argv = ["-v", "curl", "-w", "%{http_code}", "https://example.com"];
    expect(withCurlStatusMarker(argv)).toEqual(argv);
  });

  test("does NOT double-inject when the user passed --write-out", () => {
    const argv = ["-v", "curl", "--write-out", "%{http_code}", "https://x"];
    expect(withCurlStatusMarker(argv)).toEqual(argv);
  });

  test("does NOT double-inject for the glued `--write-out=` form", () => {
    const argv = ["-v", "curl", "--write-out=%{http_code}", "https://x"];
    expect(withCurlStatusMarker(argv)).toEqual(argv);
  });

  test("recognises curl invoked by absolute path", () => {
    expect(
      withCurlStatusMarker(["-v", "/usr/bin/curl", "https://example.com"]),
    ).toEqual([
      "-v",
      "/usr/bin/curl",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
  });

  test("respects pay's `--` separator before the wrapped tool", () => {
    expect(
      withCurlStatusMarker(["-v", "--", "curl", "https://example.com"]),
    ).toEqual([
      "-v",
      "--",
      "curl",
      "https://example.com",
      "-w",
      PACT_CURL_STATUS_WRITE_OUT,
    ]);
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
    {
      name: "no payment attempted + non-zero exit + no status hint → tool_error",
      payExitCode: 1,
      stdoutText: "",
      stderrText: "",
      expect: "tool_error",
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

// ----------------------------------------------------------------------
// Facilitator coverage registration (0.2.3)
//
// After `pay` exits, if a payment was attempted and --no-coverage was
// not passed, pact pay POSTs a coverage receipt to
// facilitator.pactnetwork.io. These tests inject both a fake pay AND a
// fake registerCoverage + a test keypair so nothing touches the network.
// ----------------------------------------------------------------------

describe("pact pay: facilitator coverage", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PACT_MAINNET_ENABLED;
    process.env.PACT_MAINNET_ENABLED = "1";
  });
  afterEach(() => {
    if (saved !== undefined) process.env.PACT_MAINNET_ENABLED = saved;
    else delete process.env.PACT_MAINNET_ENABLED;
  });

  const KP = Keypair.generate();

  function fakeRegister(decision: CoverageDecision): {
    fn: (i: RegisterCoverageInput) => Promise<CoverageDecision>;
    calls: RegisterCoverageInput[];
  } {
    const calls: RegisterCoverageInput[] = [];
    const fn = async (i: RegisterCoverageInput) => {
      calls.push(i);
      return decision;
    };
    return { fn, calls };
  }

  const X402_RESOURCE_TRACE =
    'Detected x402 challenge resource="https://x.example/v1/q"\n';

  test("covered (settlement_pending) on success → '[pact] base … + premium … (covered: pool pay-default)'", async () => {
    const summary = new BufStream();
    const { fn, calls } = fakeRegister({
      coverageId: "cov_OK",
      status: "settlement_pending",
      premiumBaseUnits: "1000",
      refundBaseUnits: "0",
      reason: "",
      callId: "00000000-0000-4000-8000-000000000001",
    });
    const result = await payCommand({
      args: ["curl", "-s", "-w", "status=%{http_code}", "https://x.example/v1/q"],
      pay: fakePay({
        exitCode: 0,
        stdout: '{"ok":true} status=200',
        stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
      keypair: KP,
      registerCoverageImpl: fn,
      project: "my-agent",
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.coverage?.status).toBe("settlement_pending");
      expect(result.coverage?.coverageId).toBe("cov_OK");
    }
    // The receipt payload was built from the classifier output.
    expect(calls.length).toBe(1);
    expect(calls[0].payload.agent).toBe(KP.publicKey.toBase58());
    expect(calls[0].payload.scheme).toBe("x402");
    expect(calls[0].payload.resource).toBe("https://x.example/v1/q");
    expect(calls[0].payload.amountBaseUnits).toBe("50000");
    expect(calls[0].payload.verdict).toBe("success");
    expect(calls[0].project).toBe("my-agent");
    // Summary line.
    expect(summary.text).toContain("[pact] base 0.05 USDC + premium 0.001 (covered: pool pay-default) (coverage cov_OK)");
    expect(summary.text).toContain("[pact] classifier: success");
  });

  test("breach (server_error) + covered → refund line + 'check status: pact pay coverage <id>'", async () => {
    const summary = new BufStream();
    const { fn } = fakeRegister({
      coverageId: "cov_B",
      status: "settlement_pending",
      premiumBaseUnits: "1000",
      refundBaseUnits: "10000",
      reason: "",
      callId: "00000000-0000-4000-8000-000000000002",
    });
    const result = await payCommand({
      args: ["curl", "-s", "-w", "status=%{http_code}", "https://x.example/v1/q"],
      pay: fakePay({
        exitCode: 0,
        stdout: '{"error":"upstream"} status=503',
        stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
      keypair: KP,
      registerCoverageImpl: fn,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.outcome).toBe("server_error");
      // exit code unchanged — pay's exit code wins.
      expect(result.exitCode).toBe(0);
    }
    expect(summary.text).toContain("[pact] classifier: server_error");
    expect(summary.text).toContain(
      "[pact] policy: refund_on_server_error — refund 0.010 settling on-chain (coverage cov_B)",
    );
    expect(summary.text).toContain("[pact] check status: pact pay coverage cov_B");
  });

  test("uncovered (no_allowance) → '(uncovered: no_allowance)' + 'run `pact approve`' hint", async () => {
    const summary = new BufStream();
    const { fn } = fakeRegister({
      coverageId: null,
      status: "uncovered",
      premiumBaseUnits: "0",
      refundBaseUnits: "0",
      reason: "no_allowance",
      callId: null,
    });
    await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://x.example/v1/q"],
      pay: fakePay({
        exitCode: 0,
        stdout: "ok status=200",
        stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
      keypair: KP,
      registerCoverageImpl: fn,
    });
    expect(summary.text).toContain("[pact] base 0.05 USDC + premium 0.000 (uncovered: no_allowance)");
    expect(summary.text).toContain("[pact] (run `pact approve` to enable coverage)");
  });

  test("facilitator unreachable → graceful '(coverage not recorded: facilitator unreachable)', exit code unchanged", async () => {
    const summary = new BufStream();
    const { fn } = fakeRegister({
      coverageId: null,
      status: "facilitator_unreachable",
      premiumBaseUnits: "0",
      refundBaseUnits: "0",
      reason: "ECONNREFUSED",
      callId: null,
    });
    const result = await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://x.example/v1/q"],
      pay: fakePay({
        exitCode: 0,
        stdout: "ok status=200",
        stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
      keypair: KP,
      registerCoverageImpl: fn,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.exitCode).toBe(0);
      expect(result.coverage?.status).toBe("facilitator_unreachable");
    }
    expect(summary.text).toContain("coverage not recorded: facilitator unreachable");
    expect(summary.text).toContain("[pact] classifier: success");
  });

  test("--no-coverage skips the facilitator call entirely", async () => {
    const summary = new BufStream();
    const { fn, calls } = fakeRegister({
      coverageId: "should_not_be_used",
      status: "settlement_pending",
      premiumBaseUnits: "1000",
      refundBaseUnits: "0",
      reason: "",
      callId: null,
    });
    const result = await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://x.example/v1/q"],
      pay: fakePay({
        exitCode: 0,
        stdout: "ok status=200",
        stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
      }),
      summaryStream: summary,
      keypair: KP,
      registerCoverageImpl: fn,
      noCoverage: true,
    });
    expect(calls.length).toBe(0);
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      expect(result.coverage).toBeNull();
    }
    expect(summary.text).toContain("(coverage skipped: --no-coverage)");
  });

  test("free passthrough (no payment) → no facilitator call, no coverage line", async () => {
    const summary = new BufStream();
    const { fn, calls } = fakeRegister({
      coverageId: "x",
      status: "settlement_pending",
      premiumBaseUnits: "0",
      refundBaseUnits: "0",
      reason: "",
      callId: null,
    });
    await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://api.github.com/zen"],
      pay: fakePay({ exitCode: 0, stdout: "Focus. status=200", stderr: "" }),
      summaryStream: summary,
      keypair: KP,
      registerCoverageImpl: fn,
    });
    expect(calls.length).toBe(0);
    expect(summary.text).not.toContain("coverage");
    expect(summary.text).not.toContain("premium");
  });

  test("no signing key resolvable → coverage skipped with 'no wallet' note", async () => {
    const savedKey = process.env.PACT_PRIVATE_KEY;
    delete process.env.PACT_PRIVATE_KEY;
    try {
      const summary = new BufStream();
      const result = await payCommand({
        args: ["curl", "-w", "status=%{http_code}", "https://x.example/v1/q"],
        pay: fakePay({
          exitCode: 0,
          stdout: "ok status=200",
          stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
        }),
        summaryStream: summary,
        // Hermetic: simulate "no wallet on host" so the assertion is
        // deterministic regardless of whether pay.sh is installed on
        // the test runner.
        skipWalletResolution: true,
      });
      expect(result.kind).toBe("passthrough");
      if (result.kind === "passthrough") expect(result.coverage).toBeNull();
      expect(summary.text).toContain("coverage skipped: no wallet");
    } finally {
      if (savedKey !== undefined) process.env.PACT_PRIVATE_KEY = savedKey;
    }
  });

  test("--json mode: meta.coverage block populated, exit code = pay's", async () => {
    // Mirrors how index.ts builds the envelope: we assert on the result
    // shape + coverageMeta() rather than spawning the CLI process.
    const { fn } = fakeRegister({
      coverageId: "cov_J",
      status: "settlement_pending",
      premiumBaseUnits: "1000",
      refundBaseUnits: "10000",
      reason: "",
      callId: "00000000-0000-4000-8000-000000000003",
    });
    const result = await payCommand({
      args: ["curl", "-w", "status=%{http_code}", "https://x.example/v1/q"],
      pay: fakePay({
        exitCode: 0,
        stdout: '{"error":"x"} status=503',
        stderr: X402_RESOURCE_TRACE + PAY_VERBOSE_SUCCESS,
      }),
      emitSummary: false, // --json suppresses the [pact] stderr lines
      keypair: KP,
      registerCoverageImpl: fn,
    });
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") {
      const meta = coverageMeta(result.coverage);
      expect(meta).toBeDefined();
      expect(meta).toEqual({
        id: "cov_J",
        status: "settlement_pending",
        premiumBaseUnits: "1000",
        refundBaseUnits: "10000",
        pool: "pay-default",
        reason: "",
        callId: "00000000-0000-4000-8000-000000000003",
      });
      expect(result.exitCode).toBe(0);
    }
  });
});
