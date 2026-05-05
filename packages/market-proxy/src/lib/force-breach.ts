// Pact Market force-breach demo mode.
//
// When `?demo_breach=1` is set AND the agent's wallet is in the
// DemoAllowlist, we add a delay equal to `endpoint.slaLatencyMs + 300ms`
// inside the wrap timing window so that wrap classifies the call as a
// `latency_breach`. This is *only* used for live demos (Solana Breakpoint,
// investor calls) — operator allowlist gating prevents abuse.
//
// Returning the delay in ms (rather than sleeping here) lets proxy.ts
// thread it into the buffered-fetch shim, where the sleep happens inside
// wrap's stopwatch.

import type { Allowlist } from "./allowlist.js";
import type { EndpointRow } from "./endpoints.js";

/**
 * Compute the demo-breach pre-fetch delay for this request.
 * Returns 0 unless force-breach is requested AND the wallet is in the
 * demo allowlist.
 */
export async function computeDemoBreachDelayMs(opts: {
  demoBreach: boolean;
  walletPubkey: string | undefined;
  demoAllowlist: Allowlist;
  endpoint: EndpointRow;
}): Promise<number> {
  const { demoBreach, walletPubkey, demoAllowlist, endpoint } = opts;
  if (!demoBreach || !walletPubkey) return 0;
  const allowed = await demoAllowlist.has(walletPubkey);
  if (!allowed) return 0;
  return endpoint.slaLatencyMs + 300;
}

/**
 * Legacy entry point — kept for the existing test surface. Delegates to
 * `computeDemoBreachDelayMs` and performs the sleep here. New callers
 * should prefer the compute variant so the sleep can be timed inside wrap.
 *
 * @deprecated prefer `computeDemoBreachDelayMs` + buffered-fetch preDelayMs
 */
export async function applyDemoBreach(opts: {
  demoBreach: boolean;
  walletPubkey: string | undefined;
  demoAllowlist: Allowlist;
  endpoint: EndpointRow;
}): Promise<boolean> {
  const delay = await computeDemoBreachDelayMs(opts);
  if (delay === 0) return false;
  await new Promise((r) => setTimeout(r, delay));
  return true;
}
