import type { EndpointHandler } from "./types.js";
import { buildUpstreamHeaders } from "./headers.js";

const MORALIS_EXTRA_ALLOWED: ReadonlySet<string> = new Set(["x-api-key"]);

export const moralisHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = buildUpstreamHeaders(req.headers, MORALIS_EXTRA_ALLOWED);
    return new Request(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: req.body ?? undefined,
      duplex: "half",
    } as RequestInit & { duplex: string });
  },

  async isInsurableMethod(_req: Request): Promise<boolean> {
    return true;
  },
};
