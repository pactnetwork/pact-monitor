import type { Context } from "hono";

let _registry: { size: number } | null = null;
let _balanceCache: { size: number } | null = null;

export function setHealthDeps(deps: { registry: { size: number }; balanceCache: { size: number } }): void {
  _registry = deps.registry;
  _balanceCache = deps.balanceCache;
}

export async function healthRoute(c: Context): Promise<Response> {
  return c.json({
    status: "ok",
    version: "v1",
    endpoints_loaded: _registry?.size ?? 0,
    cache_size: _balanceCache?.size ?? 0,
  });
}
