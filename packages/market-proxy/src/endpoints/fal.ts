// fal.ai image generation — REST passthrough.
//
// SLA 8000ms, premium 1% of call cost (configured in the endpoints
// registry). All POST/GET calls are insurable.
import type { EndpointHandler } from "./types.js";
import { buildUpstreamHeaders } from "./headers.js";

// fal.ai auth model: `Authorization: Key <key>` injected server-side
// (proxy-secret), never caller-supplied. We do not forward any
// caller auth header.
// TODO: confirm with the upstream API spec; if fal ever adds a
// caller-scoped header, list it here explicitly.
const FAL_EXTRA_ALLOWED: ReadonlySet<string> = new Set();

export const falHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = buildUpstreamHeaders(req.headers, FAL_EXTRA_ALLOWED);
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
