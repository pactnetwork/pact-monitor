import type { Context } from "hono";
import { randomUUID } from "crypto";
import { getContext } from "../lib/context.js";
import { handlerRegistry } from "../lib/registry.js";
import { Timer } from "../lib/timing.js";
import { applyDemoBreach } from "../lib/force-breach.js";
import type { SettleEvent } from "../lib/events.js";

export async function proxyRoute(c: Context): Promise<Response> {
  const slug = c.req.param("slug") ?? "";
  const { registry, demoAllowlist, balanceCache, publisher } = getContext();

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

  const pactWallet = c.req.query("pact_wallet");
  const demoBreach = c.req.query("demo_breach") === "1";

  // Uninsured passthrough — no pact_wallet
  if (!pactWallet) {
    const upstreamReq = await handler.buildRequest(c.req.raw, endpoint.upstreamBase);
    const upstreamResp = await fetch(upstreamReq);
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
    });
  }

  // Balance check
  const balance = await balanceCache.get(pactWallet);
  if (balance < endpoint.flatPremiumLamports) {
    return c.json({ error: "insufficient balance", required: endpoint.flatPremiumLamports.toString() }, 402);
  }

  // Check if request method is insurable
  const insurable = await handler.isInsurableMethod(c.req.raw);
  if (!insurable) {
    const upstreamReq = await handler.buildRequest(c.req.raw, endpoint.upstreamBase);
    const upstreamResp = await fetch(upstreamReq);
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
    });
  }

  // Force-breach (demo mode)
  const breachForced = await applyDemoBreach({
    demoBreach,
    walletPubkey: pactWallet,
    demoAllowlist,
    endpoint,
  });

  const timer = new Timer();

  let upstreamResp: Response;
  let networkError = false;
  try {
    const upstreamReq = await handler.buildRequest(c.req.raw, endpoint.upstreamBase);
    upstreamResp = await fetch(upstreamReq);
  } catch (err) {
    console.error("[proxy] upstream fetch error", slug, err);
    networkError = true;
    // Return 502 but still publish settle event
    upstreamResp = new Response(JSON.stringify({ error: "upstream unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  timer.markFirstByte();
  const latencyMs = timer.latencyMs();

  let result;
  if (networkError) {
    result = {
      outcome: "server_error" as const,
      premium: endpoint.flatPremiumLamports,
      refund: endpoint.imputedCostLamports,
      breach: true,
      reason: "network" as const,
    };
  } else if (breachForced) {
    result = {
      outcome: "server_error" as const,
      premium: endpoint.flatPremiumLamports,
      refund: endpoint.imputedCostLamports,
      breach: true,
      reason: "5xx" as const,
    };
  } else {
    result = await handler.classify(upstreamResp, latencyMs, endpoint);
  }

  const event: SettleEvent = {
    call_id: randomUUID(),
    agent_wallet: pactWallet as string,
    slug,
    outcome: result.outcome,
    breach: result.breach,
    reason: result.reason,
    premium_lamports: result.premium.toString(),
    refund_lamports: result.refund.toString(),
    latency_ms: latencyMs,
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget
  publisher.publish(event).catch((err) => console.error("[proxy] publish error", err));

  const respHeaders = new Headers(upstreamResp.headers);
  respHeaders.set("X-Pact-Call-Id", event.call_id);
  respHeaders.set("X-Pact-Outcome", result.outcome);
  respHeaders.set("X-Pact-Premium-Lamports", result.premium.toString());
  respHeaders.set("X-Pact-Refund-Lamports", result.refund.toString());
  respHeaders.set("X-Pact-Breach", result.breach ? "1" : "0");

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}
