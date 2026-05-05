import { randomUUID } from "node:crypto";
import { fetchEndpoints, resolveSlug, invalidateCache } from "../lib/discovery.ts";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import { signedRequest } from "../lib/transport.ts";
import { type Envelope, type Outcome } from "../lib/envelope.ts";

export interface RunOpts {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  configDir: string;
  gatewayUrl: string;
  project: string;
  cluster: "devnet" | "mainnet";
  raw?: boolean;
  skipBalanceCheck?: boolean;
  timeoutMs?: number;
}

export async function runCommand(opts: RunOpts): Promise<Envelope> {
  let endpoints;
  try {
    endpoints = await fetchEndpoints({
      configDir: opts.configDir,
      gatewayUrl: opts.gatewayUrl,
    });
  } catch (err) {
    return {
      status: "discovery_unreachable",
      body: { gateway_url: opts.gatewayUrl, error: (err as Error).message },
    };
  }

  let slug = "raw";
  let upstreamPath = new URL(opts.url).pathname + new URL(opts.url).search;

  if (!opts.raw) {
    const r = resolveSlug({ url: opts.url, endpoints: endpoints.endpoints });
    if (!r.ok) {
      if (r.reason === "no_provider") {
        return {
          status: "no_provider",
          body: { hostname: r.hostname, suggest: "use --raw for an uninsured call" },
        };
      }
      return {
        status: "endpoint_paused",
        body: { hostname: r.hostname },
      };
    }
    slug = r.slug;
    upstreamPath = r.upstreamPath;
  }

  const wallet = loadOrCreateWallet({ configDir: opts.configDir });

  let resp;
  try {
    resp = await signedRequest({
      gatewayUrl: opts.gatewayUrl,
      slug,
      upstreamPath,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      keypair: wallet.keypair,
      project: opts.project,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    return {
      status: "server_error",
      body: { error: (err as Error).message },
      meta: {
        slug,
        outcome: "server_error",
        latency_ms: -1,
        tx_signature: null,
      },
    };
  }

  // Cache-invalidating retry on 404/410/423 with a Pact-* header
  if (
    (resp.status === 404 && resp.body.includes("unknown_slug")) ||
    resp.status === 410 ||
    (resp.status === 423 && !opts.raw)
  ) {
    invalidateCache(opts.configDir);
    if (resp.status === 423) {
      return {
        status: "endpoint_paused",
        body: { slug },
      };
    }
    // refresh and retry once for 404/410
    const refreshed = await fetchEndpoints({
      configDir: opts.configDir,
      gatewayUrl: opts.gatewayUrl,
      forceRefresh: true,
    });
    const r2 = resolveSlug({ url: opts.url, endpoints: refreshed.endpoints });
    if (r2.ok) {
      const retry = await signedRequest({
        gatewayUrl: opts.gatewayUrl,
        slug: r2.slug,
        upstreamPath: r2.upstreamPath,
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        keypair: wallet.keypair,
        project: opts.project,
        timeoutMs: opts.timeoutMs,
      });
      return buildEnvelope(retry, r2.slug);
    }
  }

  return buildEnvelope(resp, slug);
}

function buildEnvelope(
  resp: { status: number; body: string; latencyMs: number },
  slug: string,
): Envelope {
  let outcome: Outcome;
  if (resp.status >= 200 && resp.status < 300) outcome = "ok";
  else if (resp.status >= 400 && resp.status < 500) outcome = "client_error";
  else outcome = "server_error";

  let parsedBody: unknown = resp.body;
  try {
    parsedBody = JSON.parse(resp.body);
  } catch {
    /* keep raw */
  }

  return {
    status: outcome,
    body: parsedBody,
    meta: {
      slug,
      call_id: `call_${randomUUID()}`,
      latency_ms: resp.latencyMs,
      outcome,
      premium_lamports: 0,
      premium_usdc: 0.0001,
      tx_signature: null,
      settlement_eta_sec: 8,
    },
  };
}
