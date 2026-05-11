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
