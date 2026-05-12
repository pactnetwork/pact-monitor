// pact pay's subprocess wrapper around solana-foundation/pay.
//
// The architectural pivot in 0.2.0 (per PAY-SH-INTEGRATION-STRATEGY.md):
// pact-cli no longer reimplements x402/MPP challenge parsing or retry
// signing. pay.sh already does that. pact pay invokes `pay <args>`
// verbatim, streams pay's output to the user in real time, and captures
// both streams so we can classify the upstream result afterwards.
//
// Capture model:
//   - stdout and stderr are TEE'd: each chunk lands in the user's terminal
//     AND in an in-memory buffer the classifier reads after pay exits.
//   - exitCode is pay's exit code; the wrapper exits with the same code
//     so shell chains behave identically whether they call `pay …` or
//     `pact pay …`.
//   - stdin is inherited so the wrapped tool can prompt (e.g. curl -u
//     prompting for a password).

import type { Subprocess } from "bun";

export interface PayShellResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type PayShellFn = (args: string[]) => Promise<PayShellResult>;

export interface RunPayInput {
  args: string[];
  pay?: PayShellFn;
}

// pay 0.16.0 emits its x402/MPP tracing lines (`402 Payment Required`,
// `Paying...`, `Payment signed, retrying...`) only when -v/--verbose is
// passed; without it stderr is empty and pact's classifier can never see
// that a payment was attempted, so every successful call falsely reports
// payment.attempted=false. We inject -v as the first pay-side flag unless
// the user has explicitly opted out with --quiet / -q / --silent.
const QUIET_FLAGS = new Set(["--quiet", "-q", "--silent"]);

export function withVerboseFlag(args: string[]): string[] {
  for (const arg of args) {
    if (QUIET_FLAGS.has(arg)) return args;
    // Only scan pay-side flags; once we hit the wrapped tool (first
    // non-flag, e.g. `curl`), subsequent --quiet/--silent belong to it.
    if (!arg.startsWith("-")) break;
  }
  return ["-v", ...args];
}

// The status marker we append to curl's output via `-w`. Plain `curl`
// (no -i / -f / -w) writes only the response body to stdout and forwards
// a 0 exit code even on a 5xx — so pact's classifier sees `tool_exit=0`
// + no parseable status and (wrongly) calls it `success`, which means
// the `server_error → refund` path can never fire via `pact pay curl`.
// Appending `-w '\n[pact-http-status=<code>]\n'` makes curl print the
// real HTTP status as an extra trailing line on stdout, which
// pay-classifier's PACT_HTTP_STATUS_RE picks up. `-w` only ADDS to
// curl's output — it does not change how curl handles the response, so
// (unlike `curl -i`, which breaks pay's own x402 parsing) it is safe to
// inject unconditionally for curl. The happy path is unaffected: a 200
// is still classified `success`, just with one extra `[pact-http-status=200]`
// line on stdout.
export const PACT_CURL_STATUS_WRITE_OUT = "\n[pact-http-status=%{http_code}]\n";

// curl flags that already define a custom write-out template. If the
// user supplied one, we don't add ours (their template wins; they can
// include `%{http_code}` themselves if they want the marker).
const CURL_WRITE_OUT_FLAGS = new Set(["-w", "--write-out"]);

// True when `tool` is curl (bare name or an absolute/relative path ending
// in `curl`). We deliberately don't touch wget / http(ie) / claude /
// codex: HTTPie already prints the status line, and claude/codex aren't
// HTTP tools.
function isCurlTool(tool: string): boolean {
  if (tool === "curl") return true;
  const base = tool.replace(/^.*[\\/]/, "");
  return base === "curl";
}

/**
 * If the wrapped tool is curl and the user hasn't already passed a
 * `-w` / `--write-out`, append `-w '\n[pact-http-status=%{http_code}]\n'`
 * to curl's argv so the upstream HTTP status surfaces in stdout for the
 * classifier (enables the SLA-breach refund path via `pact pay curl`).
 *
 * `args` is the argv as passed to `pay` (already including any leading
 * `-v` from withVerboseFlag). pay's own flags precede the wrapped tool;
 * the first non-`-` token is the wrapped tool, everything after it is
 * the tool's argv. We never inject before `--` and never for non-curl
 * tools.
 */
export function withCurlStatusMarker(args: string[]): string[] {
  // Locate the wrapped tool: the first token that isn't a pay-side flag.
  let toolIdx = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // pay's `--` separator: the wrapped tool is the next token.
      toolIdx = i + 1;
      break;
    }
    if (!a.startsWith("-")) {
      toolIdx = i;
      break;
    }
  }
  if (toolIdx < 0 || toolIdx >= args.length) return args;
  if (!isCurlTool(args[toolIdx])) return args;
  // The user already specified their own write-out template — leave it.
  for (let i = toolIdx + 1; i < args.length; i++) {
    const a = args[i];
    if (CURL_WRITE_OUT_FLAGS.has(a)) return args;
    // `-w<template>` / `--write-out=<template>` glued forms.
    if (a.startsWith("--write-out=")) return args;
    if (a.startsWith("-w") && a.length > 2) return args;
  }
  return [...args, "-w", PACT_CURL_STATUS_WRITE_OUT];
}

/**
 * Default implementation: spawn `pay <args>` via Bun.spawn with stdin
 * inherited. stdout/stderr are tee'd to the user's terminal and an
 * internal buffer for post-classification.
 */
export const DEFAULT_PAY_SHELL: PayShellFn = async (args) => {
  const proc: Subprocess = Bun.spawn(["pay", ...args], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Tee each stream as it arrives: write to the user's tty AND accumulate
  // in a buffer the classifier will read once the subprocess exits.
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const pump = async (
    src: ReadableStream<Uint8Array> | null,
    tty: NodeJS.WriteStream,
    sink: Uint8Array[],
  ): Promise<void> => {
    if (!src) return;
    const reader = src.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        sink.push(value);
        tty.write(value);
      }
    }
  };

  const stdoutSrc = proc.stdout as ReadableStream<Uint8Array> | null;
  const stderrSrc = proc.stderr as ReadableStream<Uint8Array> | null;
  await Promise.all([
    pump(stdoutSrc, process.stdout, stdoutChunks),
    pump(stderrSrc, process.stderr, stderrChunks),
  ]);
  const exitCode = await proc.exited;

  return {
    exitCode,
    stdout: concat(stdoutChunks),
    stderr: concat(stderrChunks),
  };
};

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Runs `pay <args>` and returns the captured streams + exit code. Tests
 * inject a `pay` override to drive deterministic outputs without
 * touching the real pay binary or the network.
 */
export async function runPay(input: RunPayInput): Promise<PayShellResult> {
  const pay = input.pay ?? DEFAULT_PAY_SHELL;
  return pay(input.args);
}

// First-run probe: pay's `account list` exits 0 even when no accounts
// exist, but its stdout omits the "mainnet:" / "localnet:" / "devnet:"
// section headers. We use the presence of any such header as a proxy
// for "the user has run pay setup at least once on this host" — when
// none are present, the next pay invocation will pop a macOS Touch ID
// prompt to provision a Solana keypair into the Keychain, and we want
// to warn the user before that happens.
export type PayProbeFn = () => Promise<{ initialized: boolean }>;

const ACCOUNT_HEADER_RE = /^\s*(mainnet|localnet|devnet|testnet):/m;

export const DEFAULT_PAY_PROBE: PayProbeFn = async () => {
  try {
    const proc: Subprocess = Bun.spawn(["pay", "account", "list"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutText = await new Response(
      proc.stdout as ReadableStream<Uint8Array>,
    ).text();
    await proc.exited;
    return { initialized: ACCOUNT_HEADER_RE.test(stdoutText) };
  } catch {
    // If we can't even spawn pay, the warning is moot — the real
    // invocation will fail with tool_missing anyway. Treat as
    // initialized so we don't print a misleading provisioning warning
    // on a host that doesn't have pay installed.
    return { initialized: true };
  }
};
