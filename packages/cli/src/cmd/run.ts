import { randomUUID } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchEndpoints, resolveSlug, invalidateCache } from "../lib/discovery.ts";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import { signedRequest, type SignedRequestResult } from "../lib/transport.ts";
import { getUsdcAtaBalanceLamports, resolveClusterConfig } from "../lib/solana.ts";
import { type Envelope, type Outcome } from "../lib/envelope.ts";

export interface RunOpts {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  configDir: string;
  gatewayUrl: string;
  project: string;
  rpcUrl?: string;
  raw?: boolean;
  skipBalanceCheck?: boolean;
  timeoutMs?: number;
  getBalanceLamports?: (pubkey: PublicKey) => Promise<bigint>;
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
  let provider: { premiumBps: number } | null = null;

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
    provider = endpoints.endpoints.find((e: { slug: string }) => e.slug === r.slug) ?? null;
  }

  const wallet = loadOrCreateWallet({ configDir: opts.configDir });

  if (!opts.skipBalanceCheck && provider) {
    const pubkey = wallet.keypair.publicKey;
    let balanceLamports: bigint;
    if (opts.getBalanceLamports) {
      balanceLamports = await opts.getBalanceLamports(pubkey);
    } else {
      const cfg = resolveClusterConfig();
      if ("error" in cfg) {
        return { status: "client_error", body: { error: cfg.error } };
      }
      const rpcUrl = opts.rpcUrl ?? "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrl, "confirmed");
      balanceLamports = await getUsdcAtaBalanceLamports({
        connection,
        agentPubkey: pubkey,
        mint: cfg.mint,
      });
    }
    const estimatedPremium = BigInt(Math.max(100, Math.ceil(provider.premiumBps * 1_000_000 / 10000)));
    if (balanceLamports < estimatedPremium) {
      return {
        status: "needs_funding",
        body: {
          wallet: pubkey.toBase58(),
          needed_usdc: Number(estimatedPremium) / 1_000_000,
          current_balance_usdc: Number(balanceLamports) / 1_000_000,
          deposit_url: `https://dashboard.pactnetwork.io/agents/${pubkey.toBase58()}`,
        },
      };
    }
  }

  let resp: SignedRequestResult;
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

  if (resp.status === 401 && (resp.headers["x-pact-error"] === "signature_rejected" || resp.body.includes("signature_rejected"))) {
    return {
      status: "signature_rejected",
      body: { hint: "clock skew likely; try `sudo ntpdate` or surface to user" },
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
  resp: SignedRequestResult,
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

  const callId = resp.callId ?? `call_${randomUUID()}`;
  const callIdSource: "proxy" | "local_fallback" = resp.callId ? "proxy" : "local_fallback";

  return {
    status: outcome,
    body: parsedBody,
    meta: {
      slug,
      call_id: callId,
      call_id_source: callIdSource,
      latency_ms: resp.latencyMs,
      outcome,
      premium_lamports: 0,
      premium_usdc: 0.0001,
      tx_signature: null,
      settlement_eta_sec: 8,
    },
  };
}
