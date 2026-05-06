import { Context } from "hono";

export async function healthRoute(c: Context) {
  return c.json({ status: "ok", version: "v1", endpoints_loaded: 0 });
}
