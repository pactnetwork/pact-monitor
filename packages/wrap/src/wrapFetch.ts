// @pact-network/wrap — main entry point.
//
// `wrapFetch` is the network-core primitive: any interface (Pact Market
// proxy, BYO SDK, x402 facilitator, etc.) wraps an upstream fetch through
// this function to insure the call against Pact Network.
//
// Lifecycle:
//   1. generate callId
//   2. (optional) balance check — short-circuits with a 402 response if
//      the agent doesn't have enough USDC + delegated allowance
//   3. record t_start
//   4. forward fetch upstream; catch network errors as `network_error`
//   5. record t_end → latency
//   6. classify (response, latency) → outcome + premium + refund
//   7. fire-and-forget sink.publish() — failures are swallowed
//   8. attach X-Pact-* headers to a NEW Response (original is not mutated)
//   9. return { response, outcome, premium, refund, latencyMs, callId }

import { attachPactHeaders } from "./headers";
import type { BalanceCheck, BalanceCheckResult } from "./balanceCheck";
import type { Classifier } from "./classifier";
import type { EventSink } from "./eventSink";
import type { EndpointConfig, Outcome, SettlementEvent } from "./types";

export interface WrapFetchOptions {
  endpointSlug: string;
  walletPubkey: string;
  upstreamUrl: string;
  init?: RequestInit;
  classifier: Classifier;
  sink: EventSink;
  balanceCheck?: BalanceCheck;
  endpointConfig: EndpointConfig;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Optional clock override (tests). */
  now?: () => number;
  /** Optional callId override; if not provided, one is generated. */
  callId?: string;
  /** Optional pool slug surfaced in X-Pact-Pool. */
  pool?: string;
}

export interface WrapFetchResult {
  response: Response;
  outcome: Outcome;
  premiumLamports: bigint;
  refundLamports: bigint;
  latencyMs: number;
  callId: string;
}

/**
 * Wraps a fetch call through Pact Network's insurance protocol.
 */
export async function wrapFetch(opts: WrapFetchOptions): Promise<WrapFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const callId = opts.callId ?? generateCallId();

  // 1. Optional balance check.
  if (opts.balanceCheck) {
    const required =
      opts.endpointConfig.flat_premium_lamports +
      opts.endpointConfig.imputed_cost_lamports;
    let balance: BalanceCheckResult;
    try {
      balance = await opts.balanceCheck.check(opts.walletPubkey, required);
    } catch (err) {
      // Balance-check infrastructure failure is upstream's problem; surface
      // 503 to the agent rather than charging on a stale read. We do NOT
      // emit a settlement event — nothing was attempted upstream.
      const body = JSON.stringify({
        error: "balance_check_failed",
        message: err instanceof Error ? err.message : String(err),
        callId,
      });
      const resp = attachPactHeaders(
        new Response(body, {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
        {
          callId,
          outcome: "server_error",
          premiumLamports: 0n,
          refundLamports: 0n,
          latencyMs: 0,
          pool: opts.pool,
        },
      );
      return {
        response: resp,
        outcome: "server_error",
        premiumLamports: 0n,
        refundLamports: 0n,
        latencyMs: 0,
        callId,
      };
    }

    if (!balance.eligible) {
      const body = JSON.stringify({
        error: "payment_required",
        reason: balance.reason,
        callId,
        ataBalance: balance.ataBalance?.toString(),
        allowance: balance.allowance?.toString(),
        requiredLamports: required.toString(),
      });
      const resp = attachPactHeaders(
        new Response(body, {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
        {
          callId,
          outcome: "client_error",
          premiumLamports: 0n,
          refundLamports: 0n,
          latencyMs: 0,
          pool: opts.pool,
        },
      );
      return {
        response: resp,
        outcome: "client_error",
        premiumLamports: 0n,
        refundLamports: 0n,
        latencyMs: 0,
        callId,
      };
    }
  }

  // 2. Forward upstream, with timing.
  const tStart = now();
  let upstreamResponse: Response | null = null;
  try {
    upstreamResponse = await fetchImpl(opts.upstreamUrl, opts.init);
  } catch {
    upstreamResponse = null; // network_error path
  }
  const tEnd = now();
  const latencyMs = Math.max(0, tEnd - tStart);

  // 3. Classify.
  const classified = opts.classifier.classify({
    response: upstreamResponse,
    latencyMs,
    endpointConfig: {
      sla_latency_ms: opts.endpointConfig.sla_latency_ms,
      flat_premium_lamports: opts.endpointConfig.flat_premium_lamports,
      imputed_cost_lamports: opts.endpointConfig.imputed_cost_lamports,
    },
  });

  // 4. Fire-and-forget event publish. We construct the promise but do NOT
  //    await it here — wrap returns as soon as the response is shaped.
  //    Sinks are required to swallow their own errors; we still defensively
  //    catch in case a sink throws synchronously.
  const event: SettlementEvent = {
    callId,
    agentPubkey: opts.walletPubkey,
    endpointSlug: opts.endpointSlug,
    premiumLamports: classified.premium.toString(),
    refundLamports: classified.refund.toString(),
    latencyMs,
    outcome: classified.outcome,
    ts: new Date(tEnd).toISOString(),
  };
  try {
    void Promise.resolve(opts.sink.publish(event)).catch(() => {
      // Sinks should swallow internally; this is the belt to their suspenders.
    });
  } catch {
    // Sync throws from sink.publish — swallow for the same reason.
  }

  // 5. Build the response we hand back. For network errors we synthesize a
  //    502, since there is no upstream Response.
  const baseResponse =
    upstreamResponse ??
    new Response(
      JSON.stringify({
        error: "upstream_unreachable",
        callId,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );

  const response = attachPactHeaders(baseResponse, {
    callId,
    outcome: classified.outcome,
    premiumLamports: classified.premium,
    refundLamports: classified.refund,
    latencyMs,
    pool: opts.pool,
    settlementPending: true,
  });

  return {
    response,
    outcome: classified.outcome,
    premiumLamports: classified.premium,
    refundLamports: classified.refund,
    latencyMs,
    callId,
  };
}

// ---------------------------------------------------------------------------
// callId generator
// ---------------------------------------------------------------------------

/**
 * Generate a unique call id. Prefers `crypto.randomUUID()` when available
 * (Node 19+, modern browsers, Workers); falls back to a 128-bit hex from
 * Math.random for environments that lack it. The fallback is good enough
 * for log correlation — collision risk for one wrap instance over its
 * lifetime is negligible at expected throughput.
 */
function generateCallId(): string {
  const c: any =
    typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback: 32 hex chars in a UUID-ish layout.
  const hex = (n: number) =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")
      .slice(0, n);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(8)}${hex(4)}`;
}
