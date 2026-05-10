import type { Context } from "hono";
import { getContext } from "../lib/context.js";
import { hostnamesForSlug } from "../lib/hostnames.js";

// Cache TTL the CLI honours when persisting the discovery payload to
// ~/.pact/endpoints-cache.json. One hour matches the legacy gateway behaviour
// and is short enough that pause/unpause changes propagate within a billing
// window.
const CACHE_TTL_SEC = 3600;

export interface DiscoveryEndpoint {
  slug: string;
  hostnames: string[];
  premiumBps: number;
  paused: boolean;
}

export interface DiscoveryResponse {
  cacheTtlSec: number;
  endpoints: DiscoveryEndpoint[];
}

export async function wellKnownEndpointsRoute(c: Context): Promise<Response> {
  const { registry } = getContext();
  const rows = await registry.getAll();

  const endpoints: DiscoveryEndpoint[] = rows
    .map((r) => ({
      slug: r.slug,
      hostnames: hostnamesForSlug(r.slug),
      premiumBps: r.percentBps,
      paused: r.paused,
    }))
    .filter((e) => e.hostnames.length > 0);

  const body: DiscoveryResponse = { cacheTtlSec: CACHE_TTL_SEC, endpoints };
  return c.json(body);
}
