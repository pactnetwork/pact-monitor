import type { EndpointHandler } from "./types.js";
import { buildUpstreamHeaders } from "./headers.js";

// Birdeye uses `X-API-KEY` — explicit caller passthrough. All other
// caller headers (Authorization, Cookie, etc.) are rejected by the
// shared allowlist in ./headers.ts.
const BIRDEYE_EXTRA_ALLOWED: ReadonlySet<string> = new Set(["x-api-key"]);

export const birdeyeHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = buildUpstreamHeaders(req.headers, BIRDEYE_EXTRA_ALLOWED);
    return new Request(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: req.body ?? undefined,
      duplex: "half",
    } as RequestInit & { duplex: string });
  },

  async isInsurableMethod(_req: Request): Promise<boolean> {
    // All Birdeye REST calls are insurable
    return true;
  },
};
