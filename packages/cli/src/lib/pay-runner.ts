// Per-tool subprocess wrapper. pact pay does NOT run a forward proxy — it
// invokes the wrapped tool (curl in v0.1.0), captures the HTTP response, and
// on a 402 challenge re-invokes the same tool with extra request headers. This
// mirrors solana-foundation/pay's curl wrapper and avoids the HTTPS-MITM /
// CA-cert install rabbit hole entirely (curl handles TLS itself in both
// invocations).
//
// Capture mechanism: append `-D <headerfile>` and `-o <bodyfile>` to user
// args. curl writes response headers to headerfile (with one block per
// redirect; we keep the last) and the body to bodyfile. stdout/stderr stay
// piped so we can replay them on the success path.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseChallenge as parseX402Challenge,
  isPaymentRejection,
  type X402Challenge,
} from "./x402.ts";
import {
  parseChallengesFromHeaders as parseMppChallenges,
  type MppChallenge,
} from "./mpp.ts";

export interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

export type RunOutcome =
  | {
      kind: "completed";
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      bodyBytes: Uint8Array;
      statusCode?: number;
    }
  | {
      kind: "x402";
      statusCode: number;
      challenge: X402Challenge;
      resourceUrl: string;
      headers: Record<string, string | string[]>;
      bodyText: string;
    }
  | {
      kind: "mpp";
      statusCode: number;
      challenges: MppChallenge[];
      resourceUrl: string;
      headers: Record<string, string | string[]>;
      bodyText: string;
    }
  | {
      kind: "rejected";
      reason: string;
      resourceUrl: string;
    }
  | {
      kind: "unknown_402";
      resourceUrl: string;
      headers: Record<string, string | string[]>;
      bodyText: string;
    }
  | {
      kind: "tool_missing";
      tool: string;
    };

export interface RunCurlInput {
  args: string[];
  extraHeaders?: string[];
  spawn?: SpawnFn;
  // Override tempdir for tests.
  tmp?: string;
}

const DEFAULT_SPAWN: SpawnFn = async (cmd, args) => {
  // Bun.spawn returns stdout/stderr as ReadableStream; await its `.exited`
  // for the exit code. We piped both so we can replay them on the
  // non-402 path without losing curl's progress writeout (`-w`).
  const proc = Bun.spawn([cmd, ...args], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).bytes(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export function findUrlInArgs(args: string[]): string | null {
  for (const a of args) {
    if (/^https?:\/\//i.test(a)) return a;
  }
  return null;
}

export function parseHttpHeaders(text: string): {
  status: number | null;
  headers: Record<string, string | string[]>;
} {
  // curl's -D dumps each redirect-chain response with a blank line between
  // them. We want the *last* response (the one whose body we have).
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return { status: null, headers: {} };
  const last = blocks[blocks.length - 1];
  const lines = last.split("\n");
  const statusLine = lines.shift() ?? "";
  const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)/);
  const status = m ? parseInt(m[1], 10) : null;
  const headers: Record<string, string | string[]> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    const existing = headers[k];
    if (existing === undefined) {
      headers[k] = v;
    } else if (Array.isArray(existing)) {
      existing.push(v);
    } else {
      headers[k] = [existing, v];
    }
  }
  return { status, headers };
}

export async function checkCommandExists(
  cmd: string,
  spawn: SpawnFn,
): Promise<boolean> {
  try {
    const r = await spawn("/bin/sh", ["-c", `command -v ${cmd}`]);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

export async function runCurl(input: RunCurlInput): Promise<RunOutcome> {
  const spawn = input.spawn ?? DEFAULT_SPAWN;
  if (!(await checkCommandExists("curl", spawn))) {
    return { kind: "tool_missing", tool: "curl" };
  }

  const baseTmp = input.tmp ?? tmpdir();
  const dir = mkdtempSync(join(baseTmp, "pact-pay-"));
  const headerPath = join(dir, "headers");
  const bodyPath = join(dir, "body");
  // Touch the files so curl can append/write reliably even if the run
  // bails out before producing anything.
  writeFileSync(headerPath, "");
  writeFileSync(bodyPath, "");

  const fullArgs: string[] = [...input.args];
  for (const h of input.extraHeaders ?? []) {
    fullArgs.push("-H", h);
  }
  fullArgs.push("-D", headerPath, "-o", bodyPath);

  let result: SpawnResult;
  try {
    result = await spawn("curl", fullArgs);
  } finally {
    /* fall through to read whatever curl produced */
  }

  let headersText = "";
  let bodyBytes: Uint8Array = new Uint8Array(0);
  try {
    headersText = readFileSync(headerPath, "utf8");
  } catch {
    /* curl may not have written headers if it failed early */
  }
  try {
    bodyBytes = readFileSync(bodyPath);
  } catch {
    /* curl may not have written a body */
  }
  // Always clean up the temp dir even if downstream throws.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }

  const { status, headers } = parseHttpHeaders(headersText);
  const url = findUrlInArgs(input.args) ?? "";

  if (status === 402) {
    const bodyText = new TextDecoder().decode(bodyBytes);

    const rejection = isPaymentRejection({ headers, body: bodyText });
    if (rejection.rejected) {
      return {
        kind: "rejected",
        reason: rejection.reason ?? "verification_failed",
        resourceUrl: url,
      };
    }

    const x402 = parseX402Challenge({ headers, body: bodyText });
    if (x402) {
      return {
        kind: "x402",
        statusCode: 402,
        challenge: x402,
        resourceUrl: url,
        headers,
        bodyText,
      };
    }

    const mpp = parseMppChallenges(headers);
    if (mpp.length > 0) {
      return {
        kind: "mpp",
        statusCode: 402,
        challenges: mpp,
        resourceUrl: url,
        headers,
        bodyText,
      };
    }

    return {
      kind: "unknown_402",
      resourceUrl: url,
      headers,
      bodyText,
    };
  }

  return {
    kind: "completed",
    exitCode: result?.exitCode ?? 1,
    stdout: result?.stdout ?? new Uint8Array(0),
    stderr: result?.stderr ?? new Uint8Array(0),
    bodyBytes,
    statusCode: status ?? undefined,
  };
}
