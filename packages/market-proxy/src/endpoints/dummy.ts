// Pact Dummy Upstream (demo) — plain-HTTP passthrough.
//
// `dummy` is the demo upstream behind `https://dummy.pactnetwork.io`
// (service `pact-dummy-upstream`, built by another agent). It exists so we
// can exercise the full premium-coverage path end-to-end without depending
// on a real third-party provider's flakiness.
//
// Routes the upstream exposes (interface contract — do not deviate):
//   GET /health
//   GET /quote/:symbol
//        ?fail=1        → 503 (drives `server_error` + refund)
//        ?latency=<ms>  → sleeps <ms> before responding (drives latency_breach)
//        ?status=<n>    → responds with HTTP status <n>
//        ?x402=1        → 402 challenge (drives client_error — agent fault under default SLA)
//
// Like Jupiter, the upstream is unauthenticated: NO caller-supplied auth
// header is forwarded. Only the shared base allowlist (Content-Type, Accept,
// Accept-Encoding, User-Agent) reaches the upstream — see ./headers.ts.
//
// Classifier: this endpoint returns plain HTTP (not JSON-RPC), so it uses
// `marketDefaultClassifier` (status-based) — see ../lib/classifiers.ts.
import type { EndpointHandler } from "./types.js";
import { buildUpstreamHeaders } from "./headers.js";

// The dummy upstream is unauthenticated — no caller-supplied auth header is
// forwarded (mirrors the Jupiter handler).
const DUMMY_EXTRA_ALLOWED: ReadonlySet<string> = new Set();

export const dummyHandler: EndpointHandler = {
  async buildRequest(req: Request, upstreamBase: string): Promise<Request> {
    const url = new URL(req.url);
    // Rewrite /v1/dummy/<rest>?<q> → <upstreamBase>/<rest>?<q> — i.e. strip the
    // `/v1/<slug>` gateway prefix the CLI/proxy route adds, then forward the
    // remaining path to the upstream. (`new URL("/v1/dummy/...", base)` would
    // forward the prefix verbatim and the upstream would 404.)
    const rest = url.pathname.replace(/^\/v1\/[^/]+/, "") || "/";
    const upstreamUrl = new URL(rest + url.search, upstreamBase);
    // Strip pact-specific query params before forwarding.
    upstreamUrl.searchParams.delete("pact_wallet");
    upstreamUrl.searchParams.delete("demo_breach");
    const headers = buildUpstreamHeaders(req.headers, DUMMY_EXTRA_ALLOWED);
    return new Request(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: req.body ?? undefined,
      duplex: "half",
    } as RequestInit & { duplex: string });
  },

  async isInsurableMethod(_req: Request): Promise<boolean> {
    // Every dummy upstream call (GET /health, GET /quote/:symbol) is insurable.
    return true;
  },
};
