import type { EndpointHandler } from "./types.js";

const INSURABLE_METHODS = new Set([
  "getAccountInfo",
  "sendTransaction",
  "getTransaction",
  "getBalance",
  "getSignatureStatuses",
  "getProgramAccounts",
]);

export const heliusHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    // strip pact-specific query params
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = new Headers(req.headers);
    headers.delete("host");
    return new Request(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half",
    } as RequestInit & { duplex: string });
  },

  async isInsurableMethod(req: Request): Promise<boolean> {
    try {
      const clone = req.clone();
      const body = (await clone.json()) as { method?: string };
      return typeof body.method === "string" && INSURABLE_METHODS.has(body.method);
    } catch {
      return false;
    }
  },
};
