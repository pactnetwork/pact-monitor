import { describe, expect, test } from "bun:test";
import { renderEnvelope } from "../src/lib/output.ts";

describe("output", () => {
  test("json mode prints envelope JSON to stdout, nothing to stderr", () => {
    const r = renderEnvelope({
      mode: "json",
      envelope: { status: "ok", body: { x: 1 }, meta: { slug: "helius", latency_ms: 100 } },
    });
    expect(JSON.parse(r.stdout)).toEqual({
      status: "ok",
      body: { x: 1 },
      meta: { slug: "helius", latency_ms: 100 },
    });
    expect(r.stderr).toBe("");
  });

  test("tty mode prints body to stdout and metadata to stderr", () => {
    const r = renderEnvelope({
      mode: "tty",
      envelope: {
        status: "ok",
        body: { x: 1 },
        meta: { slug: "helius", latency_ms: 287, premium_usdc: 0.0001 },
      },
    });
    expect(r.stdout).toContain('"x":1');
    expect(r.stderr).toContain("helius");
    expect(r.stderr).toContain("287ms");
  });

  test("quiet mode prints only body to stdout", () => {
    const r = renderEnvelope({
      mode: "quiet",
      envelope: {
        status: "ok",
        body: "raw text",
        meta: { slug: "helius" },
      },
    });
    expect(r.stdout).toBe("raw text");
    expect(r.stderr).toBe("");
  });

  test("string body in tty mode prints raw", () => {
    const r = renderEnvelope({
      mode: "tty",
      envelope: { status: "ok", body: "hello" },
    });
    expect(r.stdout).toBe("hello");
  });

  test("error status in tty prints metadata to stderr", () => {
    const r = renderEnvelope({
      mode: "tty",
      envelope: {
        status: "needs_funding",
        body: { wallet: "abc", needed_usdc: 5 },
      },
    });
    expect(r.stderr).toContain("needs_funding");
  });
});
