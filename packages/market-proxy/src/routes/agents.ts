import type { Context } from "hono";
import { getContext } from "../lib/context.js";

export async function agentsRoute(c: Context): Promise<Response> {
  const pubkey = c.req.param("pubkey") ?? "";
  const { balanceCache } = getContext();

  try {
    const balance = await balanceCache.get(pubkey);
    return c.json({
      pubkey,
      balance_lamports: balance.toString(),
    });
  } catch (err) {
    console.error("[agents] error reading wallet", pubkey, err);
    return c.json({ error: "failed to read agent wallet" }, 502);
  }
}
