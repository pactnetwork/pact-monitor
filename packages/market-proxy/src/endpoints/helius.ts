import type { EndpointRow } from "../lib/endpoints.js";
import type { ClassifyResult, EndpointHandler } from "./types.js";

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
      const body = await clone.json() as { method?: string };
      return typeof body.method === "string" && INSURABLE_METHODS.has(body.method);
    } catch {
      return false;
    }
  },

  async classify(resp: Response, latencyMs: number, endpoint: EndpointRow): Promise<ClassifyResult> {
    const { flatPremiumLamports, imputedCostLamports, slaLatencyMs } = endpoint;

    if (resp.status === 429) {
      // rate limited — no premium, no refund
      return { outcome: "client_error", premium: 0n, refund: 0n, breach: false };
    }

    if (resp.status >= 500) {
      return { outcome: "server_error", premium: flatPremiumLamports, refund: imputedCostLamports, breach: true, reason: "5xx" };
    }

    if (resp.status >= 400) {
      return { outcome: "client_error", premium: 0n, refund: 0n, breach: false };
    }

    // 2xx — check JSON-RPC error and latency
    if (resp.status === 200) {
      try {
        const clone = resp.clone();
        const body = await clone.json() as { error?: { code?: number } };
        if (body.error) {
          const code = body.error.code;
          if (code === -32603 || code === -32000) {
            // internal / server error — refund eligible
            return { outcome: "server_error", premium: flatPremiumLamports, refund: imputedCostLamports, breach: true, reason: "5xx" };
          }
          // user/client errors (invalid params, etc.) — no premium
          return { outcome: "client_error", premium: 0n, refund: 0n, breach: false };
        }
      } catch {
        // non-JSON body, treat as ok
      }

      if (latencyMs > slaLatencyMs) {
        return { outcome: "server_error", premium: flatPremiumLamports, refund: imputedCostLamports, breach: true, reason: "latency" };
      }

      return { outcome: "ok", premium: flatPremiumLamports, refund: 0n, breach: false };
    }

    return { outcome: "ok", premium: flatPremiumLamports, refund: 0n, breach: false };
  },
};
