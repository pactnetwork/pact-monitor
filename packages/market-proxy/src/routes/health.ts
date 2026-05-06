import type { Context } from "hono";

let _registry: { size: number } | null = null;

export function setHealthDeps(deps: { registry: { size: number } }): void {
  _registry = deps.registry;
}

export async function healthRoute(c: Context): Promise<Response> {
  return c.json({
    status: "ok",
    version: "v1",
    endpoints_loaded: _registry?.size ?? 0,
  });
}
