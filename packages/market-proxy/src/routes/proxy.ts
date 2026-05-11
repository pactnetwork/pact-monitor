// Pact Market proxy route.
//
// On every request:
//   1. Resolve endpoint config from registry (slug, premium, SLA, etc.).
//   2. Pick the per-provider handler (URL rewriter + insurability check).
//   3. If the request isn't insurable, OR the agent didn't supply an
//      identity (`x-pact-agent` header, falling back to the legacy
//      `pact_wallet` query param), passthrough without invoking wrap.
//   4. Otherwise, look up the per-provider Classifier (composed with
//      `defaultClassifier` from @pact-network/wrap) and call `wrapFetch`.
//      wrap handles balance check, timing, classification, sink publish,
//      and X-Pact-* headers.
//   5. Force-breach demo mode (Market-specific) sleeps before forwarding
//      so wrap naturally classifies the result as a `latency_breach`.

import type { Context } from "hono";
import { wrapFetch, type EndpointConfig } from "@pact-network/wrap";
import { getContext } from "../lib/context.js";
import { handlerRegistry } from "../lib/registry.js";
import { computeDemoBreachDelayMs } from "../lib/force-breach.js";
import { classifierRegistry } from "../lib/classifiers.js";
import { createBufferedFetch } from "../lib/buffered-fetch.js";
import { buildSanitisedResponse } from "../lib/response-headers.js";

export async function proxyRoute(c: Context): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  const { registry, demoAllowlist, balanceCheck, sink } = getContext();

  const endpoint = await registry.get(slug);
  if (!endpoint) {
    return c.json({ error: "endpoint not found" }, 404);
  }
  if (endpoint.paused) {
    return c.json({ error: "endpoint paused" }, 503);
  }

  const handler = handlerRegistry[slug];
  if (!handler) {
    return c.json({ error: "no handler for endpoint" }, 501);
  }

  // Agent identity: the CLI transmits the agent pubkey in the `x-pact-agent`
  // header alongside its signed payload (see packages/cli/src/lib/transport.ts).
  // The dashboard demo path still uses the `pact_wallet` query param, which we
  // keep as a fallback for backwards compatibility until that surface migrates.
  const pactWallet =
    c.req.header("x-pact-agent") ?? c.req.query("pact_wallet");
  const demoBreach = c.req.query("demo_breach") === "1";

  // -----------------------------------------------------------------------
  // Uninsured passthrough — no agent identity. We still rewrite the URL via
  // the per-endpoint handler but skip wrap entirely so no premium is
  // charged and no event is published.
  // -----------------------------------------------------------------------
  if (!pactWallet) {
    const upstreamReq = await handler.buildRequest(c.req.raw, endpoint.upstreamBase);
    const upstreamResp = await fetch(upstreamReq);
    // Alan review M2: strip Set-Cookie/Server/CORS leaks from upstream.
    return buildSanitisedResponse(upstreamResp);
  }

  // -----------------------------------------------------------------------
  // Non-insurable request shape (e.g. unknown JSON-RPC method) — also a
  // passthrough. No premium, no event.
  // -----------------------------------------------------------------------
  const insurable = await handler.isInsurableMethod(c.req.raw);
  if (!insurable) {
    const upstreamReq = await handler.buildRequest(c.req.raw, endpoint.upstreamBase);
    const upstreamResp = await fetch(upstreamReq);
    // Alan review M2: strip Set-Cookie/Server/CORS leaks from upstream.
    return buildSanitisedResponse(upstreamResp);
  }

  // -----------------------------------------------------------------------
  // Force-breach demo mode (Market-specific). When the wallet is in the
  // DemoAllowlist and `?demo_breach=1` is set, threading a pre-fetch delay
  // into the buffered-fetch shim makes wrap's stopwatch include the sleep,
  // so wrap classifies the call as `latency_breach` naturally.
  // -----------------------------------------------------------------------
  const preDelayMs = await computeDemoBreachDelayMs({
    demoBreach,
    walletPubkey: pactWallet,
    demoAllowlist,
    endpoint,
  });

  // -----------------------------------------------------------------------
  // Build the upstream Request and the per-endpoint Classifier. For
  // body-aware endpoints (Helius JSON-RPC) we wire wrap's fetchImpl through
  // a buffered shim so the classifier can sync-inspect the parsed body.
  // -----------------------------------------------------------------------
  const upstreamReq = await handler.buildRequest(c.req.raw, endpoint.upstreamBase);
  const factory = classifierRegistry[slug];

  const buffered = createBufferedFetch({ upstreamRequest: upstreamReq, preDelayMs });
  const classifier =
    factory.kind === "needsBody"
      ? factory.build(buffered.getParsedBody)
      : factory.classifier;

  const endpointConfig: EndpointConfig = {
    slug,
    sla_latency_ms: endpoint.slaLatencyMs,
    flat_premium_lamports: endpoint.flatPremiumLamports,
    imputed_cost_lamports: endpoint.imputedCostLamports,
  };

  const result = await wrapFetch({
    endpointSlug: slug,
    walletPubkey: pactWallet,
    upstreamUrl: upstreamReq.url,
    classifier,
    sink,
    balanceCheck,
    endpointConfig,
    fetchImpl: buffered.fetchImpl,
    pool: slug,
  });

  // Alan review M2: wrap's response carries upstream headers (with
  // X-Pact-* added on top by attachPactHeaders). Strip the upstream-leak
  // set (Set-Cookie / Server / X-Powered-By / Access-Control-* / ...) but
  // preserve every X-Pact-* that wrap attached.
  const pactHeaders = new Headers();
  for (const [name, value] of result.response.headers.entries()) {
    if (name.toLowerCase().startsWith("x-pact-")) {
      pactHeaders.set(name, value);
    }
  }
  return buildSanitisedResponse(result.response, pactHeaders);
}
