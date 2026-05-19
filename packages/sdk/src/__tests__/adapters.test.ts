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
  it("wraps a fetch-like function (string + Request inputs)", async () => {
    const { pactFetch, calls } = recordingFetch();
    const wrapped = wrapClient(globalThis.fetch, pactFetch) as typeof fetch;
    const res = await wrapped("https://api.helius.xyz/v0/x");
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://api.helius.xyz/v0/x");

    // A Request input must NOT collapse to a GET with init===undefined —
    // method/headers/body have to survive (PR #210 finding 1).
    await wrapped(
      new Request("https://api.helius.xyz/v0/p", {
        method: "POST",
        body: "z",
        headers: { "x-test": "1" },
      }),
    );
    expect(calls[1].url).toBe("https://api.helius.xyz/v0/p");
    expect(calls[1].init?.method).toBe("POST");
    expect(
      new TextDecoder().decode(calls[1].init?.body as Uint8Array),
    ).toBe("z");
    expect(
      (calls[1].init?.headers as Record<string, string>)["x-test"],
    ).toBe("1");
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

  it("wraps a got instance via beforeRequest short-circuit (json + GET)", async () => {
    const { pactFetch, calls } = recordingFetch();
    let hook!: (o: unknown) => Promise<unknown>;
    const got = Object.assign(
      function () {
        /* got callable */
      },
      {
        defaults: { options: {} },
        extend(opts: { hooks: { beforeRequest: ((o: unknown) => Promise<unknown>)[] } }) {
          hook = opts.hooks.beforeRequest[0];
          return { __gotExtended: true };
        },
      },
    );
    const wrapped = wrapClient(got, pactFetch) as { __gotExtended: boolean };
    expect(wrapped.__gotExtended).toBe(true);

    // POST with `json` -> materialized to a JSON body + content-type before
    // pact.fetch signs/sends it (got would otherwise ignore post-hoc json).
    const resLike = (await hook({
      url: new URL("https://api.helius.xyz/v0/x?k=v"),
      method: "post",
      headers: { "x-test": "1" },
      json: { a: 1 },
    })) as {
      statusCode: number;
      headers: Record<string, string>;
      complete: boolean;
      pipe: unknown;
    };
    expect(calls[0].url).toBe("https://api.helius.xyz/v0/x?k=v");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe(JSON.stringify({ a: 1 }));
    expect(
      (calls[0].init?.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
    // Returned object is an IncomingMessage-like got can consume.
    expect(resLike.statusCode).toBe(200);
    expect(resLike.complete).toBe(true);
    expect(typeof resLike.pipe).toBe("function");
    expect(resLike.headers["x-pact-call-id"]).toBe("c");

    await hook({ url: new URL("https://api.helius.xyz/g"), method: "GET" });
    expect(calls[1].url).toBe("https://api.helius.xyz/g");
    expect(calls[1].init?.method).toBe("GET");
    expect(calls[1].init?.body).toBeUndefined();
  });

  it("axios wrapper preserves HTTP error semantics (validateStatus)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const statusFetch =
      (status: number): PactFetchFn =>
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ e: 1 }), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
    const mkAxios = () => {
      const axios = {
        interceptors: { request: {}, response: {} },
        defaults: {} as Record<string, unknown>,
      };
      return axios;
    };

    // Default axios behavior: non-2xx rejects with an AxiosError-shaped err.
    const a1 = wrapClient(mkAxios(), statusFetch(500)) as {
      defaults: { adapter: (c: unknown) => Promise<unknown> };
    };
    await expect(
      a1.defaults.adapter({
        url: "https://api.helius.xyz/x",
        method: "get",
        headers: {},
        validateStatus: (s: number) => s >= 200 && s < 300,
      }),
    ).rejects.toMatchObject({
      isAxiosError: true,
      name: "AxiosError",
      code: "ERR_BAD_RESPONSE",
      status: 500,
    });
    const a1b = wrapClient(mkAxios(), statusFetch(404)) as {
      defaults: { adapter: (c: unknown) => Promise<{ status?: number }> };
    };
    await a1b.defaults
      .adapter({
        url: "https://api.helius.xyz/x",
        method: "get",
        headers: {},
        validateStatus: (s: number) => s >= 200 && s < 300,
      })
      .then(
        () => {
          throw new Error("should have rejected");
        },
        (e: { code: string; response: { status: number } }) => {
          expect(e.code).toBe("ERR_BAD_REQUEST");
          expect(e.response.status).toBe(404);
        },
      );

    // validateStatus opt-out (null) => a 500 resolves, as axios allows.
    const a2 = wrapClient(mkAxios(), statusFetch(500)) as {
      defaults: { adapter: (c: unknown) => Promise<{ status: number }> };
    };
    const ok = await a2.defaults.adapter({
      url: "https://api.helius.xyz/x",
      method: "get",
      headers: {},
      validateStatus: null,
    });
    expect(ok.status).toBe(500);
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
