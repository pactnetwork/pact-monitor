// MerchantRegistry (E5) — boot, refresh, ETag, unknown-pubkey behavior.

import { describe, it, expect, vi } from "vitest";
import { MerchantRegistry } from "../merchant-registry.js";

function fakeFetch(
  responses: Array<{ status: number; body?: unknown; etag?: string }>,
) {
  const calls: Array<{ url: string; ifNoneMatch?: string }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    const ifNoneMatch =
      (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
    calls.push({ url: url.toString(), ifNoneMatch });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const headers = new Headers();
    if (r.etag) headers.set("etag", r.etag);
    return new Response(r.body ? JSON.stringify(r.body) : null, {
      status: r.status,
      headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("MerchantRegistry", () => {
  it("populates from the boot fetch and exposes hasMerchant + getMerchantHostnames", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        etag: '"abc"',
        body: {
          merchants: [
            { pubkey: "PK1", label: "m1", hostnames: ["a.example", "b.example"] },
            { pubkey: "PK2", label: "m2", hostnames: [] },
          ],
          generatedAt: new Date().toISOString(),
        },
      },
    ]);
    const reg = new MerchantRegistry({
      backendBaseUrl: "http://test",
      fetchImpl: impl,
    });
    await reg.start();
    expect(reg.hasMerchant("PK1")).toBe(true);
    expect(reg.hasMerchant("PK2")).toBe(true);
    expect(reg.hasMerchant("PK_UNKNOWN")).toBe(false);
    expect(reg.getMerchantHostnames("PK1")).toEqual(["a.example", "b.example"]);
    reg.stop();
  });

  it("sends If-None-Match on subsequent refresh and leaves cache intact on 304", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        etag: '"v1"',
        body: {
          merchants: [{ pubkey: "PK1", label: "m1", hostnames: ["a.example"] }],
          generatedAt: new Date().toISOString(),
        },
      },
      { status: 304 },
    ]);
    const reg = new MerchantRegistry({
      backendBaseUrl: "http://test",
      fetchImpl: impl,
    });
    await reg.start();
    expect(reg.hasMerchant("PK1")).toBe(true);
    await reg.refresh();
    expect(calls.length).toBe(2);
    expect(calls[1].ifNoneMatch).toBe('"v1"');
    // Cache survived the 304.
    expect(reg.hasMerchant("PK1")).toBe(true);
    reg.stop();
  });

  it("survives a failed fetch — never throws, returns false to caller", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const reg = new MerchantRegistry({
      backendBaseUrl: "http://test",
      fetchImpl: failing,
    });
    await reg.start(); // does not throw
    expect(reg.hasMerchant("anyone")).toBe(false);
    reg.stop();
  });

  it("replaces the cache on a non-304 success with new contents", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        etag: '"v1"',
        body: {
          merchants: [{ pubkey: "PK_A", label: "a", hostnames: [] }],
          generatedAt: new Date().toISOString(),
        },
      },
      {
        status: 200,
        etag: '"v2"',
        body: {
          merchants: [{ pubkey: "PK_B", label: "b", hostnames: [] }],
          generatedAt: new Date().toISOString(),
        },
      },
    ]);
    const reg = new MerchantRegistry({
      backendBaseUrl: "http://test",
      fetchImpl: impl,
    });
    await reg.start();
    expect(reg.hasMerchant("PK_A")).toBe(true);
    await reg.refresh();
    expect(reg.hasMerchant("PK_A")).toBe(false);
    expect(reg.hasMerchant("PK_B")).toBe(true);
    reg.stop();
  });
});
