import type { EndpointHandler } from "./types.js";
import { buildUpstreamHeaders } from "./headers.js";

const INSURABLE_METHODS = new Set([
  "getAccountInfo",
  "sendTransaction",
  "getTransaction",
  "getBalance",
  "getSignatureStatuses",
  "getProgramAccounts",
]);

// Helius authenticates via query string `?api-key=…` injected by the
// operator (or already on `upstreamBase`). No caller-supplied auth header
// is allowed to forward — see ./headers.ts.
const HELIUS_EXTRA_ALLOWED: ReadonlySet<string> = new Set();

export const heliusHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    // strip pact-specific query params
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = buildUpstreamHeaders(req.headers, HELIUS_EXTRA_ALLOWED);
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
