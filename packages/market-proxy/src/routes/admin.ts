import type { Context } from "hono";
import { env } from "../env.js";
import { getContext } from "../lib/context.js";

export async function adminRoute(c: Context): Promise<Response> {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== env.ENDPOINTS_RELOAD_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { registry, demoAllowlist, operatorAllowlist } = getContext();
  await Promise.all([registry.reload(), demoAllowlist.reload(), operatorAllowlist.reload()]);
  return c.json({ ok: true, endpoints_loaded: registry.size });
}
