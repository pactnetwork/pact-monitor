/**
 * `pact.wrap(client)` — route an existing HTTP client through `pact.fetch`
 * so the agent gets coverage without rewriting call sites.
 *
 * Robustly supported (structural detection, no client imported as a dep):
 *   - ky instance      -> client.extend({ fetch })           (ky's fetch hook)
 *   - axios instance   -> client.defaults.adapter = ...       (fetch adapter)
 *   - got instance     -> client.extend({ hooks.beforeRequest })  (delegates
 *                          fully to pact.fetch by returning a response-like,
 *                          short-circuiting got's own transport — got's
 *                          documented custom-transport/cache seam)
 *   - any fetch fn     -> returns a pact-routed fetch         (undici.fetch,
 *                                                              global fetch)
 *
 * `pact.wrap` throws a clear, typed error for unsupported clients (use
 * `pact.fetch` directly instead). Every adapter — got included — inherits the
 * golden rule from `pact.fetch`: since got's transport is short-circuited and
 * the call is serviced by `pact.fetch`, the proxy/bare/degrade decision and
 * "never throw on Pact's behalf" guarantee are exactly the same as a direct
 * `pact.fetch`. No got-side bare-retry shim is needed or used.
 */
import type { Readable as NodeReadable } from "node:stream";
import { PactError, PactErrorCode } from "./errors.js";

export type PactFetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

function isKyLike(c: unknown): c is { extend: (opts: unknown) => unknown } {
  return (
    typeof c === "function" &&
    typeof (c as { extend?: unknown }).extend === "function" &&
    typeof (c as { create?: unknown }).create === "function"
  );
}

function isAxiosLike(
  c: unknown,
): c is { defaults: Record<string, unknown>; interceptors: unknown } {
  return (
    !!c &&
    (typeof c === "function" || typeof c === "object") &&
    typeof (c as { interceptors?: unknown }).interceptors === "object" &&
    typeof (c as { defaults?: unknown }).defaults === "object"
  );
}

function isGotLike(c: unknown): c is { extend: (o: unknown) => unknown } {
  // got instance: a callable with `.extend` and `.defaults.options`, but NOT
  // ky (`.create`) and NOT axios (`.interceptors`).
  return (
    typeof c === "function" &&
    typeof (c as { extend?: unknown }).extend === "function" &&
    typeof (c as { create?: unknown }).create !== "function" &&
    typeof (c as { interceptors?: unknown }).interceptors !== "object" &&
    typeof (c as { defaults?: { options?: unknown } }).defaults?.options ===
      "object"
  );
}

async function requestUrlAndInit(
  input: unknown,
  init?: RequestInit,
): Promise<{ url: string; init: RequestInit }> {
  if (typeof input === "string") return { url: input, init: init ?? {} };
  if (input instanceof URL) return { url: input.toString(), init: init ?? {} };
  // A Request (ky builds one): extract url/method/headers/body.
  const req = input as Request;
  const headers: Record<string, string> = {};
  req.headers?.forEach?.((v, k) => {
    headers[k] = v;
  });
  let body: BodyInit | undefined;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    const buf = await req.arrayBuffer().catch(() => null);
    if (buf && buf.byteLength > 0) body = new Uint8Array(buf);
  }
  return {
    url: req.url,
    init: { method: req.method, headers, body, ...init },
  };
}

function wrapKy(client: unknown, pactFetch: PactFetchFn): unknown {
  const kyFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const { url, init: i } = await requestUrlAndInit(input, init);
    return pactFetch(url, i);
  };
  return (client as { extend: (o: unknown) => unknown }).extend({
    fetch: kyFetch,
  });
}

interface AxiosishConfig {
  url?: string;
  baseURL?: string;
  method?: string;
  headers?: unknown;
  data?: unknown;
  params?: Record<string, unknown>;
  responseType?: string;
}

function flattenAxiosHeaders(h: unknown): Record<string, string> {
  if (!h) return {};
  const maybe = h as { toJSON?: () => Record<string, unknown> };
  const src =
    typeof maybe.toJSON === "function"
      ? maybe.toJSON()
      : (h as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (typeof v === "object") continue; // skip axios method-buckets
    out[k] = String(v);
  }
  return out;
}

function buildAxiosUrl(config: AxiosishConfig): string {
  let u = config.url ?? "";
  if (config.baseURL && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    u =
      config.baseURL.replace(/\/+$/, "") +
      (u.startsWith("/") ? "" : "/") +
      u;
  }
  if (config.params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params)) {
      if (v != null) sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs) u += (u.includes("?") ? "&" : "?") + qs;
  }
  return u;
}

function wrapAxios(client: unknown, pactFetch: PactFetchFn): unknown {
  const adapter = async (config: AxiosishConfig) => {
    const url = buildAxiosUrl(config);
    const method = (config.method ?? "get").toUpperCase();
    const headers = flattenAxiosHeaders(config.headers);
    let body: BodyInit | undefined;
    if (config.data != null && method !== "GET" && method !== "HEAD") {
      body =
        typeof config.data === "string"
          ? config.data
          : JSON.stringify(config.data);
      if (typeof config.data !== "string" && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
    const res = await pactFetch(url, { method, headers, body });
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const rt = config.responseType;
    const data =
      rt === "arraybuffer"
        ? await res.arrayBuffer()
        : rt === "text"
          ? await res.text()
          : await res
              .clone()
              .json()
              .catch(() => res.text());
    return {
      data,
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      config,
      request: undefined,
    };
  };
  (client as { defaults: Record<string, unknown> }).defaults.adapter =
    adapter;
  return client;
}

interface GotOptionsish {
  url: URL | string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  json?: unknown;
  form?: Record<string, unknown>;
}

function gotHeaders(h: GotOptionsish["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** Materialize got's intended request body to the exact bytes we'll send. */
function gotBody(o: GotOptionsish): {
  body?: BodyInit;
  extraHeaders: Record<string, string>;
} {
  const m = (o.method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return { body: undefined, extraHeaders: {} };
  if (o.body != null) return { body: o.body as BodyInit, extraHeaders: {} };
  if (o.json !== undefined) {
    return {
      body: JSON.stringify(o.json),
      extraHeaders: { "content-type": "application/json" },
    };
  }
  if (o.form !== undefined) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(o.form)) {
      if (v != null) sp.set(k, String(v));
    }
    return {
      body: sp.toString(),
      extraHeaders: {
        "content-type": "application/x-www-form-urlencoded",
      },
    };
  }
  return { body: undefined, extraHeaders: {} };
}

/**
 * got adapter. got's transport is not fetch-shaped, so instead of bridging
 * it we use got's documented `beforeRequest` short-circuit: the hook returns
 * an `IncomingMessage`-like, which makes got skip its own request entirely
 * and use our response. The call is serviced by `pact.fetch`, so the golden
 * rule (proxy/bare/degrade, never-throw-on-Pact's-behalf) is identical to a
 * direct `pact.fetch`. No bare-retry shim — got never makes the request.
 */
function wrapGot(client: unknown, pactFetch: PactFetchFn): unknown {
  const beforeRequest = async (opts: GotOptionsish): Promise<unknown> => {
    const url = String(opts.url);
    const { body, extraHeaders } = gotBody(opts);
    const headers = { ...gotHeaders(opts.headers), ...extraHeaders };
    const res = await pactFetch(url, {
      method: (opts.method ?? "GET").toUpperCase(),
      headers,
      body,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const { Readable } = await import("node:stream");
    const stream = Readable.from(buf) as NodeReadable &
      Record<string, unknown>;
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    // Shape got expects from a custom transport (see got cache.md).
    stream.statusCode = res.status;
    stream.statusMessage = res.statusText;
    stream.headers = resHeaders;
    stream.trailers = {};
    stream.socket = null;
    stream.aborted = false;
    stream.complete = true;
    stream.url = url;
    stream.httpVersion = "1.1";
    stream.httpVersionMinor = 1;
    stream.httpVersionMajor = 1;
    return stream;
  };
  return (client as { extend: (o: unknown) => unknown }).extend({
    hooks: { beforeRequest: [beforeRequest] },
  });
}

export function wrapClient<T>(client: T, pactFetch: PactFetchFn): T {
  if (isKyLike(client)) return wrapKy(client, pactFetch) as T;
  if (isGotLike(client)) return wrapGot(client, pactFetch) as T;
  if (isAxiosLike(client)) return wrapAxios(client, pactFetch) as T;
  if (typeof client === "function") {
    // A fetch-like function (undici.fetch, global fetch, a custom fetch).
    const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return pactFetch(url, init);
    };
    return wrapped as T;
  }
  throw new PactError(
    PactErrorCode.CONFIG_INVALID,
    "pact.wrap: unsupported client. Supported: a ky instance, an axios " +
      "instance, or a fetch function. For others, call pact.fetch directly.",
  );
}
