// `pact pay coverage <coverageId>` — look up the status of a pay.sh
// coverage registration on facilitator.pact.network.
//
// Mirrors `pact calls <id>` (the gateway-path call lookup): GETs
// `${PACT_FACILITATOR_URL}/v1/coverage/:id` and surfaces the coverage
// status plus, once the on-chain `settle_batch` has confirmed, the tx
// signature and a Solscan link. The facilitator may also return a
// `callId` — when it does, `pact calls <callId>` shows the full
// on-chain settlement record (same as a gateway-path call).

import type { Envelope } from "../lib/envelope.ts";
import { getCoverageStatus, resolveFacilitatorUrl } from "../lib/facilitator.ts";

// Coverage IDs are facilitator-assigned; we don't enforce a strict
// format (the facilitator might use a UUID, a base58 hash, etc.) — just
// reject obviously empty / whitespace input before burning a round-trip.
function isPlausibleCoverageId(id: string): boolean {
  return typeof id === "string" && id.trim().length >= 4 && !/\s/.test(id);
}

function solscanTxUrl(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export async function payCoverageStatusCommand(opts: {
  coverageId: string;
  facilitatorUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<Envelope> {
  if (!isPlausibleCoverageId(opts.coverageId)) {
    return {
      status: "client_error",
      body: {
        error: "invalid_coverage_id",
        message:
          "Pass the coverage id printed by `pact pay` (e.g. `pact pay coverage <id>`).",
        coverage_id: opts.coverageId,
      },
    };
  }

  const base = opts.facilitatorUrl ?? resolveFacilitatorUrl();
  const r = await getCoverageStatus({
    coverageId: opts.coverageId,
    facilitatorUrl: base,
    fetchImpl: opts.fetchImpl,
  });

  if (r.status === "not_found") {
    return {
      status: "client_error",
      body: {
        error: "coverage_not_found",
        coverage_id: opts.coverageId,
        facilitator: base,
        http_status: r.httpStatus ?? 404,
      },
    };
  }
  if (r.status === "server_error") {
    return {
      status: "server_error",
      body: {
        error: "facilitator_error",
        coverage_id: opts.coverageId,
        facilitator: base,
        http_status: r.httpStatus,
      },
    };
  }
  if (r.status === "unreachable") {
    return {
      status: "discovery_unreachable",
      body: {
        error: "facilitator_unreachable",
        coverage_id: opts.coverageId,
        facilitator: base,
        detail: r.error,
      },
    };
  }

  // ok
  const settleSig = r.settleBatchSignature ?? null;
  const meta: Record<string, unknown> = {
    coverage_id: r.coverageId ?? opts.coverageId,
    coverage_status: r.coverageStatus ?? null,
    facilitator: base,
  };
  if (r.callId) meta.call_id = r.callId;
  if (settleSig) {
    meta.settle_batch_signature = settleSig;
    meta.solscan_url = solscanTxUrl(settleSig);
  }
  return {
    status: "ok",
    body: (r.body ?? {}) as Record<string, unknown>,
    meta,
  };
}
