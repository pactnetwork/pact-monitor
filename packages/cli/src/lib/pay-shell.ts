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
