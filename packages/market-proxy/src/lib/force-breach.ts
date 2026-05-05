import type { Allowlist } from "./allowlist.js";
import type { EndpointRow } from "./endpoints.js";

export async function applyDemoBreach(opts: {
  demoBreach: boolean;
  walletPubkey: string | undefined;
  demoAllowlist: Allowlist;
  endpoint: EndpointRow;
}): Promise<boolean> {
  const { demoBreach, walletPubkey, demoAllowlist, endpoint } = opts;
  if (!demoBreach || !walletPubkey) return false;
  const allowed = await demoAllowlist.has(walletPubkey);
  if (!allowed) return false;
  const delay = endpoint.slaLatencyMs + 300;
  await new Promise((r) => setTimeout(r, delay));
  return true;
}
