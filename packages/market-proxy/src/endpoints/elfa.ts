// Elfa AI signals — REST passthrough.
//
// SLA 1500ms, premium $0.0005 (configured in the endpoints registry).
import type { EndpointHandler } from "./types.js";
import { buildUpstreamHeaders } from "./headers.js";

// Elfa AI auth model: the upstream API uses bearer auth via
// `Authorization: Bearer <api-key>` injected by the operator (proxy-side
// secret), not caller-supplied. Forwarding caller `Authorization` would
// leak agent identity.
// TODO: confirm with the upstream API spec; if Elfa ever introduces a
// caller-scoped header, list it here explicitly.
const ELFA_EXTRA_ALLOWED: ReadonlySet<string> = new Set();

export const elfaHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = buildUpstreamHeaders(req.headers, ELFA_EXTRA_ALLOWED);
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
