import type { Context } from "hono";
import { getContext } from "../lib/context.js";

/**
 * Agent introspection endpoint. Returns the agent's USDC ATA balance and
 * SPL Token allowance against Pact's settlement authority. We probe with a
 * tiny `requiredLamports = 1` so we get the underlying numbers regardless
 * of insurability.
 */
export async function agentsRoute(c: Context): Promise<Response> {
  const pubkey = c.req.param("pubkey") ?? "";
  const { balanceCheck } = getContext();

  try {
    const result = await balanceCheck.check(pubkey, 1n);
    if (result.eligible) {
      return c.json({
        pubkey,
        ata_balance_lamports: result.ataBalance.toString(),
        allowance_lamports: result.allowance.toString(),
        eligible: true,
      });
    }
    return c.json({
      pubkey,
      reason: result.reason,
      ata_balance_lamports: result.ataBalance?.toString() ?? "0",
      allowance_lamports: result.allowance?.toString() ?? "0",
      eligible: false,
    });
  } catch (err) {
    console.error("[agents] error reading wallet", pubkey, err);
    return c.json({ error: "failed to read agent wallet" }, 502);
  }
}
