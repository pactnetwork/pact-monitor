import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHttpHeaders,
  findUrlInArgs,
  runCurl,
  type SpawnFn,
} from "../src/lib/pay-runner.ts";
import { HEADER_PAYMENT_REQUIRED_V2 } from "../src/lib/x402.ts";
import { HEADER_WWW_AUTHENTICATE, SCHEME_SOLANA_CHARGE } from "../src/lib/mpp.ts";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

const X402_REQS = {
  scheme: "exact",
  network: "solana",
  maxAmountRequired: "10000",
  resource: "https://api.example.com/v1/quote",
  description: "AAPL quote",
  payTo: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const MPP_CHARGE = {
  amount: "10000",
  currency: "USDC",
  recipient: "GsfNSuZFrT2r4xzJYnh7y3i6E3jB1WgrVrA8x4mpBvKM",
  description: "AAPL quote",
};

describe("parseHttpHeaders", () => {
  test("parses status + headers from a single response block", () => {
    const text =
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Foo: bar\r\n\r\n";
    const r = parseHttpHeaders(text);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["x-foo"]).toBe("bar");
  });

  test("keeps only the last response after redirect chain", () => {
    const text =
      "HTTP/1.1 301 Moved\r\nLocation: /elsewhere\r\n\r\n" +
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n";
    const r = parseHttpHeaders(text);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain");
    expect(r.headers["location"]).toBeUndefined();
  });

  test("collects repeated headers into an array", () => {
    const text =
      "HTTP/1.1 402 Payment Required\r\n" +
      'WWW-Authenticate: SolanaCharge realm="a", charge="x"\r\n' +
      'WWW-Authenticate: SolanaCharge realm="b", charge="y"\r\n\r\n';
    const r = parseHttpHeaders(text);
    expect(r.status).toBe(402);
    expect(Array.isArray(r.headers["www-authenticate"])).toBe(true);
    expect((r.headers["www-authenticate"] as string[]).length).toBe(2);
  });
});

describe("findUrlInArgs", () => {
  test("returns the first http(s) URL", () => {
    expect(findUrlInArgs(["-X", "GET", "https://api.example.com/x"])).toBe(
      "https://api.example.com/x",
    );
  });

  test("returns null when no URL is present", () => {
    expect(findUrlInArgs(["--help"])).toBeNull();
  });
});

describe("runCurl with stub spawn", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-pay-runner-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stubSpawnWriting(headers: string, body: Buffer): SpawnFn {
    // The real default spawn writes to the -D / -o paths via curl. The stub
    // walks the args list, finds those flags, and writes the canned content
    // so the runner sees what curl would have produced.
    return async (cmd, args) => {
      if (cmd === "/bin/sh") return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      const dIdx = args.indexOf("-D");
      const oIdx = args.indexOf("-o");
      if (dIdx >= 0 && args[dIdx + 1]) writeFileSync(args[dIdx + 1], headers);
      if (oIdx >= 0 && args[oIdx + 1]) writeFileSync(args[oIdx + 1], body);
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    };
  }

  test("classifies x402 challenge from header", async () => {
    const env = { x402Version: 2, accepts: [X402_REQS] };
    const headers =
      "HTTP/1.1 402 Payment Required\r\n" +
      "Content-Type: application/json\r\n" +
      `${HEADER_PAYMENT_REQUIRED_V2}: ${b64(env)}\r\n\r\n`;
    const out = await runCurl({
      args: ["https://api.example.com/v1/quote"],
      spawn: stubSpawnWriting(headers, Buffer.from("{}")),
      tmp: dir,
    });
    expect(out.kind).toBe("x402");
    if (out.kind === "x402") {
      expect(out.statusCode).toBe(402);
      expect(out.challenge.accepts[0].network).toBe("solana");
      expect(out.resourceUrl).toBe("https://api.example.com/v1/quote");
    }
  });

  test("classifies MPP challenge from www-authenticate", async () => {
    const headers =
      "HTTP/1.1 402 Payment Required\r\n" +
      `${HEADER_WWW_AUTHENTICATE}: ${SCHEME_SOLANA_CHARGE} realm="api", charge="${b64(MPP_CHARGE)}"\r\n\r\n`;
    const out = await runCurl({
      args: ["https://api.example.com/v1/quote"],
      spawn: stubSpawnWriting(headers, Buffer.from("")),
      tmp: dir,
    });
    expect(out.kind).toBe("mpp");
    if (out.kind === "mpp") {
      expect(out.challenges).toHaveLength(1);
      expect(out.challenges[0].charge.currency).toBe("USDC");
    }
  });

  test("classifies completed (200) response and surfaces body", async () => {
    const headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n";
    const body = Buffer.from('{"ok":true}');
    const out = await runCurl({
      args: ["https://api.example.com/v1/quote"],
      spawn: stubSpawnWriting(headers, body),
      tmp: dir,
    });
    expect(out.kind).toBe("completed");
    if (out.kind === "completed") {
      expect(out.statusCode).toBe(200);
      expect(new TextDecoder().decode(out.bodyBytes)).toBe('{"ok":true}');
    }
  });

  test("classifies payment rejection body as `rejected`", async () => {
    const headers =
      "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\n\r\n";
    const body = Buffer.from(
      JSON.stringify({ error: "verification_failed", reason: "expired" }),
    );
    const out = await runCurl({
      args: ["https://api.example.com/v1/quote"],
      spawn: stubSpawnWriting(headers, body),
      tmp: dir,
    });
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") expect(out.reason).toBe("expired");
  });

  test("classifies unknown 402 (no recognized payment protocol)", async () => {
    const headers = "HTTP/1.1 402 Payment Required\r\n\r\n";
    const out = await runCurl({
      args: ["https://api.example.com/v1/quote"],
      spawn: stubSpawnWriting(headers, Buffer.from("")),
      tmp: dir,
    });
    expect(out.kind).toBe("unknown_402");
  });

  test("appends -D, -o, and extra -H flags to user args", async () => {
    let captured: string[] = [];
    const spawn: SpawnFn = async (cmd, args) => {
      if (cmd === "/bin/sh") return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      captured = args;
      const dIdx = args.indexOf("-D");
      const oIdx = args.indexOf("-o");
      writeFileSync(args[dIdx + 1], "HTTP/1.1 200 OK\r\n\r\n");
      writeFileSync(args[oIdx + 1], "");
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    };
    await runCurl({
      args: ["-X", "POST", "https://api.example.com/v1/quote"],
      extraHeaders: ['X-Pact-Test: v=1'],
      spawn,
      tmp: dir,
    });
    expect(captured).toContain("-X");
    expect(captured).toContain("-D");
    expect(captured).toContain("-o");
    expect(captured).toContain("-H");
    expect(captured).toContain("X-Pact-Test: v=1");
  });

  test("returns tool_missing when curl is absent", async () => {
    const spawn: SpawnFn = async (cmd) => {
      if (cmd === "/bin/sh") return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
      throw new Error("should not get here");
    };
    const out = await runCurl({
      args: ["https://api.example.com/v1/quote"],
      spawn,
      tmp: dir,
    });
    expect(out.kind).toBe("tool_missing");
  });
});
