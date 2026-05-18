import { describe, it, expect } from "vitest";
import { wrapClient, type PactFetchFn } from "../adapters.js";
import { PactError, PactErrorCode } from "../errors.js";

function recordingFetch(): {
  pactFetch: PactFetchFn;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const pactFetch: PactFetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, url }), {
      status: 200,
      headers: { "content-type": "application/json", "X-Pact-Call-Id": "c" },
    });
  };
  return { pactFetch, calls };
}

describe("wrapClient", () => {
  it("wraps a fetch-like function", async () => {
    const { pactFetch, calls } = recordingFetch();
    const wrapped = wrapClient(globalThis.fetch, pactFetch) as PactFetchFn;
    const res = await wrapped("https://api.helius.xyz/v0/x");
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://api.helius.xyz/v0/x");
  });

  it("wraps a ky instance via its fetch hook (string + Request inputs)", async () => {
    const { pactFetch, calls } = recordingFetch();
    const ky = Object.assign(
      function () {
        /* ky callable */
      },
      {
        create() {
          return ky;
        },
        extend(opts: { fetch: typeof fetch }) {
          return { __kyFetch: opts.fetch };
        },
      },
    );
    const wrapped = wrapClient(ky, pactFetch) as { __kyFetch: typeof fetch };
    await wrapped.__kyFetch("https://api.helius.xyz/a");
    await wrapped.__kyFetch(
      new Request("https://api.helius.xyz/b", { method: "POST", body: "z" }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.helius.xyz/a",
      "https://api.helius.xyz/b",
    ]);
    expect(calls[1].init?.method).toBe("POST");
  });

  it("wraps an axios instance by replacing its adapter", async () => {
    const { pactFetch, calls } = recordingFetch();
    const axios = {
      interceptors: { request: {}, response: {} },
      defaults: {} as Record<string, unknown>,
    };
    const wrapped = wrapClient(axios, pactFetch) as typeof axios;
    const adapter = wrapped.defaults.adapter as (
      c: unknown,
    ) => Promise<{ data: unknown; status: number; headers: unknown }>;
    const resp = await adapter({
      url: "/v0/x",
      baseURL: "https://api.helius.xyz/",
      method: "post",
      data: { a: 1 },
      headers: {},
      params: { k: "v" },
    });
    expect(calls[0].url).toBe("https://api.helius.xyz/v0/x?k=v");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ a: 1 });
    expect(resp.status).toBe(200);
    expect((resp.data as { ok: boolean }).ok).toBe(true);
  });

  it("throws a typed error for an unsupported client", () => {
    const { pactFetch } = recordingFetch();
    try {
      wrapClient({ not: "a client" }, pactFetch);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).code).toBe(PactErrorCode.CONFIG_INVALID);
    }
  });
});
