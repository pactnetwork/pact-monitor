import type { EndpointRow } from "../lib/endpoints.js";
import type { ClassifyResult, EndpointHandler } from "./types.js";

export const jupiterHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    const upstreamUrl = new URL(url.pathname + url.search, upstreamBase);
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = new Headers(req.headers);
    headers.delete("host");
    // Jupiter has no auth header requirement
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

  async classify(resp: Response, latencyMs: number, endpoint: EndpointRow): Promise<ClassifyResult> {
    const { flatPremiumLamports, imputedCostLamports, slaLatencyMs } = endpoint;

    if (resp.status === 429) {
      return { outcome: "client_error", premium: 0n, refund: 0n, breach: false };
    }

    if (resp.status >= 500) {
      return { outcome: "server_error", premium: flatPremiumLamports, refund: imputedCostLamports, breach: true, reason: "5xx" };
    }

    if (resp.status >= 400) {
      return { outcome: "client_error", premium: 0n, refund: 0n, breach: false };
    }

    if (latencyMs > slaLatencyMs) {
      return { outcome: "server_error", premium: flatPremiumLamports, refund: imputedCostLamports, breach: true, reason: "latency" };
    }

    return { outcome: "ok", premium: flatPremiumLamports, refund: 0n, breach: false };
  },
};
