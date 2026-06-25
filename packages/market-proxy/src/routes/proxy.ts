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
import { signProxiedBy } from "@q3labs/pact-sdk/merchant";
import { getContext } from "../lib/context.js";
import { handlerRegistry } from "../lib/registry.js";
import { computeDemoBreachDelayMs } from "../lib/force-breach.js";
import { classifierRegistry } from "../lib/classifiers.js";
import { createBufferedFetch } from "../lib/buffered-fetch.js";
import { buildSanitisedResponse } from "../lib/response-headers.js";
import { adapterToBalanceCheck } from "../lib/balance.js";
import {
  getProxyMerchantIdentity,
  type ProxyMerchantIdentity,
} from "../lib/merchant-identity.js";

export async function proxyRoute(c: Context): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  const network = c.req.header("x-pact-network");
  const { registry, demoAllowlist, balanceCheck: legacyBalanceCheck, sink, adapters, legacyDirectSolana } = getContext();

  const endpoint = await registry.get(slug, network);
  if (!endpoint) {
    const available = await registry.getNetworksForSlug(slug);
    if (available.length === 0) {
      return c.json({ error: "endpoint not found" }, 404);
    }
    if (network) {
      return c.json({
        error: "endpoint_not_found",
        message: `endpoint "${slug}" not found on network "${network}". Available networks: ${available.join(", ")}`,
      }, 404);
    }
    return c.json({
      error: "endpoint_ambiguous",
      message: `Set X-Pact-Network header to disambiguate: ${available.join(", ")}`,
    }, 404);
  }
  if (endpoint.paused) {
    return c.json({ error: "endpoint paused" }, 503);
  }

  const handler = handlerRegistry[slug];
  if (!handler) {
    return c.json({ error: "no handler for endpoint" }, 501);
  }

  // Resolve the network for this endpoint. The DB row carries a `network`
  // column (added in WP-MN-03a). EndpointRegistry defaults to "solana-devnet"
  // for rows from before the migration so this is always a valid network string.
  const endpointNetwork = endpoint.network;

  // Select balance check: legacy direct (from createBalanceCheck) or
  // adapter-backed (from ChainAdapter.checkAgentEligibility).
  const adapterForNetwork = adapters.get(endpointNetwork);
  let balanceCheck: import("@pact-network/wrap").BalanceCheck;
  if (legacyDirectSolana && endpointNetwork.startsWith("solana-")) {
    balanceCheck = legacyBalanceCheck;
  } else if (adapterForNetwork) {
    balanceCheck = adapterToBalanceCheck(adapterForNetwork);
  } else {
    // Adapter missing for this network — explicit 503 + WARN log.
    // Silent fallback to legacyBalanceCheck was removed in WP-MN-03b T5:
    // an unknown network means the operator has not enabled it in
    // PACT_ENABLED_NETWORKS, so we must not silently degrade to Solana.
    console.warn(
      `[proxy] endpoint "${endpoint.slug}" requires network "${endpointNetwork}", not in PACT_ENABLED_NETWORKS`,
    );
    return c.text(
      `Network "${endpointNetwork}" not enabled on this proxy`,
      503,
    );
  }

  // Agent identity: the CLI transmits the agent pubkey in the `x-pact-agent`
  // header alongside its signed payload (see packages/cli/src/lib/transport.ts).
  // The dashboard demo path still uses the `pact_wallet` query param. Issue
  // #164: that fallback bypasses verify-signature.ts (which is a no-op when
  // `x-pact-agent` is absent), so it is gated behind PACT_PROXY_INSECURE_DEMO
  // and rejected by default in production.
  const headerAgent = c.req.header("x-pact-agent");
  const queryAgent = c.req.query("pact_wallet");
  let pactWallet: string | undefined;
  if (headerAgent) {
    pactWallet = headerAgent;
  } else if (queryAgent) {
    if (process.env.PACT_PROXY_INSECURE_DEMO !== "1") {
      return c.json(
        {
          error: "pact_auth_missing",
          message:
            "?pact_wallet= is gated by PACT_PROXY_INSECURE_DEMO in this environment. Send an authenticated x-pact-agent header instead.",
        },
        401,
      );
    }
    pactWallet = queryAgent;
  }
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

  // J3: honor the agent SDK's outbound x-pact-started-at. When present, we
  // anchor latency math on the agent's wall clock instead of our own — so
  // the recorded latency is true agent → proxy → upstream, and the
  // call_records.timestamp matches the agent's own /records ingest of the
  // same call (the partial unique index dedupe key).
  const startedAtRaw = c.req.header("x-pact-started-at");
  const startedAtParsed = startedAtRaw ? Number(startedAtRaw) : NaN;
  const overrideStartedAt = Number.isFinite(startedAtParsed)
    ? startedAtParsed
    : undefined;

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
    network: endpointNetwork,
    overrideStartedAt,
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

  // J2: stamp X-Pact-Proxied-By + X-Pact-Proxied-Sig so the agent SDK can
  // verify, skip its own local record write, and emit an `attributed` event.
  // Skipped silently when the proxy was booted without a merchant identity
  // (degrades to the legacy double-write path — DB unique index dedupes).
  const merchant: ProxyMerchantIdentity | null = getProxyMerchantIdentity();
  if (merchant) {
    const startedAt = overrideStartedAt ?? Date.now();
    const sig = signProxiedBy(
      {
        merchantPubkey: merchant.publicKeyB58,
        agentPubkey: pactWallet,
        startedAt,
        endpoint: slug,
        statusCode: result.response.status,
      },
      merchant.secretKey,
    );
    pactHeaders.set("X-Pact-Proxied-By", merchant.publicKeyB58);
    pactHeaders.set("X-Pact-Proxied-Sig", sig);
  }
  return buildSanitisedResponse(result.response, pactHeaders);
}
