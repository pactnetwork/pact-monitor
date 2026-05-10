import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProviderEndpoint {
  slug: string;
  hostnames: string[];
  premiumBps: number;
  paused: boolean;
}

interface DiscoveryResponse {
  cacheTtlSec: number;
  endpoints: ProviderEndpoint[];
}

interface CacheFile extends DiscoveryResponse {
  fetchedAt: number;
}

export function cachePath(configDir: string): string {
  return join(configDir, "endpoints-cache.json");
}

export async function fetchEndpoints(opts: {
  configDir: string;
  gatewayUrl: string;
  forceRefresh?: boolean;
}): Promise<CacheFile> {
  const path = cachePath(opts.configDir);
  if (!opts.forceRefresh && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < cached.cacheTtlSec * 1000) {
      return cached;
    }
  }
  const url = `${opts.gatewayUrl.replace(/\/$/, "")}/.well-known/endpoints`;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
      return cached;
    }
    throw new Error(`discovery_unreachable: ${resp.status}`);
  }
  const body = (await resp.json()) as DiscoveryResponse;
  const file: CacheFile = { ...body, fetchedAt: Date.now() };
  if (!existsSync(opts.configDir)) {
    mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, JSON.stringify(file, null, 2));
  return file;
}

export function invalidateCache(configDir: string): void {
  const path = cachePath(configDir);
  if (existsSync(path)) rmSync(path);
}

export type SlugResolution =
  | { ok: true; slug: string; upstreamPath: string; provider: ProviderEndpoint }
  | { ok: false; reason: "no_provider" | "endpoint_paused"; hostname: string };

export function resolveSlug(opts: {
  url: string;
  endpoints: ProviderEndpoint[];
}): SlugResolution {
  const u = new URL(opts.url);
  const hostname = u.hostname;
  const match = opts.endpoints.find((e) => e.hostnames.includes(hostname));
  if (!match) return { ok: false, reason: "no_provider", hostname };
  if (match.paused) return { ok: false, reason: "endpoint_paused", hostname };
  return {
    ok: true,
    slug: match.slug,
    upstreamPath: u.pathname + u.search,
    provider: match,
  };
}
