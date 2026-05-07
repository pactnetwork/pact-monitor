// @pact-network/wrap — X-Pact-* response headers.
//
// Every wrapped response is annotated with these headers so the agent (and
// any downstream observer) can see what wrap charged, what it refunded, the
// observed latency, the classifier outcome, and the pool the call settled
// against.

import type { Outcome } from "./types";

export const HEADERS = {
  PREMIUM: "X-Pact-Premium",
  REFUND: "X-Pact-Refund",
  LATENCY_MS: "X-Pact-Latency-Ms",
  OUTCOME: "X-Pact-Outcome",
  POOL: "X-Pact-Pool",
  SETTLEMENT_PENDING: "X-Pact-Settlement-Pending",
} as const;

export interface PactHeaderInputs {
  callId: string;
  outcome: Outcome;
  premiumLamports: bigint;
  refundLamports: bigint;
  latencyMs: number;
  /** Optional pool slug, e.g. "helius-mainnet". */
  pool?: string;
  /**
   * If true, settlement has been queued (sink.publish was called) but is not
   * yet on-chain. The settler worker will reconcile.
   */
  settlementPending?: boolean;
}

/**
 * Returns a NEW Response with X-Pact-* headers attached. The original
 * Response is not mutated — its headers are copied into a fresh Headers
 * instance so that downstream code holding a reference to the original sees
 * the original.
 *
 * Body, status, and statusText are passed through unchanged.
 */
export function attachPactHeaders(
  response: Response,
  inputs: PactHeaderInputs,
): Response {
  const headers = new Headers(response.headers);
  headers.set(HEADERS.PREMIUM, inputs.premiumLamports.toString());
  headers.set(HEADERS.REFUND, inputs.refundLamports.toString());
  headers.set(HEADERS.LATENCY_MS, inputs.latencyMs.toString());
  headers.set(HEADERS.OUTCOME, inputs.outcome);
  if (inputs.pool !== undefined) {
    headers.set(HEADERS.POOL, inputs.pool);
  }
  if (inputs.settlementPending) {
    headers.set(HEADERS.SETTLEMENT_PENDING, "1");
  }
  // Surface the call id so the agent can correlate with settlement events.
  headers.set("X-Pact-Call-Id", inputs.callId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
