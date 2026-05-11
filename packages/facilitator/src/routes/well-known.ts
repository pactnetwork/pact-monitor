// GET /.well-known/pay-coverage — facilitator metadata.
//
// Analogous to the market-proxy's /.well-known/endpoints: tells callers what
// schemes the facilitator covers, which coverage pool pay.sh-covered calls
// land in, the flat premium rate, the imputed refund, the hourly exposure cap,
// and — importantly — the "subsidised launch pool" disclosure (this is a
// Pact-funded float, not an actuarially-priced product yet).

import type { Context } from "hono";
import { getContext } from "../lib/context.js";
import { readPoolConfig } from "../lib/pool-config.js";

// The CLI may cache this; one hour matches the gateway's /.well-known/endpoints.
const CACHE_TTL_SEC = 3600;

export async function wellKnownPayCoverageRoute(c: Context): Promise<Response> {
  const { pg, payDefaults, usdcMint } = getContext();
  const pool = await readPoolConfig(pg, payDefaults.slug, payDefaults);

  return c.json({
    cacheTtlSec: CACHE_TTL_SEC,
    service: "pact-facilitator",
    // The routing model — side-call / receipt-registrar (NOT facilitator-as-payee).
    model: "side-call",
    // Schemes the CLI may register receipts for.
    supportedSchemes: ["x402", "mpp"],
    // The synthetic coverage-pool every pay.sh-covered call lands in (MVP).
    pools: [
      {
        slug: pool.slug,
        description: "Shared launch pool for all pay.sh-covered calls (MVP).",
        asset: usdcMint,
        flatPremiumBaseUnits: pool.flatPremiumLamports.toString(),
        // Per-call refund CEILING on a covered breach. The actual refund is
        // the amount the agent paid the merchant, capped at this — and on
        // chain it's clamped again by `exposureCapPerHourBaseUnits`.
        perCallRefundCeilingBaseUnits: pool.imputedCostLamports.toString(),
        slaLatencyMs: pool.slaLatencyMs,
        exposureCapPerHourBaseUnits: pool.exposureCapPerHourLamports.toString(),
        paused: pool.paused,
        configSource: pool.source,
      },
    ],
    // How the refund amount is determined on a covered breach.
    refundPolicy: "amount_paid_capped_at_per_call_ceiling_then_hourly_exposure_cap",
    // The premium funding source: the agent's own `pact approve` allowance
    // (delegate = SettlementAuthority PDA). No allowance => uncovered.
    premiumFunding: "agent_allowance",
    // The refund funding source: a Pact-subsidised, capped launch pool.
    refundFunding: "pact_subsidised_launch_pool",
    // Plain-language disclosure.
    disclosure:
      "The pay-default coverage pool is a Pact-subsidised launch float with a " +
      "tight hourly exposure cap. Premiums (minus the Treasury fee) flow into " +
      "the pool, so it trends toward self-sustaining; until then refunds are " +
      "bounded by the on-chain hourly exposure cap and the pool's current " +
      "balance. This is not yet an actuarially-priced product.",
    // How a covered call settles: the same Pub/Sub -> settler -> settle_batch
    // machinery the gateway path uses (source: "pay.sh").
    settlement: "onchain_settle_batch_via_shared_settler",
  });
}
