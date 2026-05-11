import type { Context } from "hono";

let _deps: { payDefaultSlug: string } | null = null;

export function setHealthDeps(deps: { payDefaultSlug: string }): void {
  _deps = deps;
}

export async function healthRoute(c: Context): Promise<Response> {
  return c.json({
    status: "ok",
    service: "pact-facilitator",
    version: "v1",
    pay_default_pool: _deps?.payDefaultSlug ?? "pay-default",
  });
}
