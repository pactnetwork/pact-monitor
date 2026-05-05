import { Context } from "hono";

// TODO: implement proxy logic in Phase 1
export async function proxyRoute(c: Context) {
  return c.json({ error: "not implemented" }, 501);
}
