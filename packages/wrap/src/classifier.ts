// @pact-network/wrap — outcome classifier.
//
// The classifier maps `(response, latencyMs, endpointConfig)` to an outcome
// and the premium/refund amounts that wrap will charge.
//
// `defaultClassifier` implements the Pact-Network-standard rules. Per-endpoint
// plugins (Helius JSON-RPC, Birdeye REST, Jupiter, etc.) live in the
// consumer (e.g. @pact-network/market-proxy) and compose with the default —
// see the example at the bottom of this file.

import { classifyHttpOutcome } from "@pact-network/classifier";
import { computeEconomics } from "./economics";
import type { Outcome } from "./types";

export interface ClassifierInput {
  /**
   * The upstream Response. May be `null` if the upstream fetch threw a
   * network error before any response was received — in that case the
   * classifier should treat it as `network_error`.
   */
  response: Response | null;
  latencyMs: number;
  endpointConfig: {
    sla_latency_ms: number;
    flat_premium_lamports: bigint;
    imputed_cost_lamports: bigint;
  };
}

export interface ClassifierResult {
  outcome: Outcome;
  premium: bigint;
  refund: bigint;
}

export interface Classifier {
  classify(input: ClassifierInput): ClassifierResult;
}

/**
 * Default classifier. Three stages, each with one job:
 *
 *  1. The status → category DECISION lives in the shared rails core
 *     (`@pact-network/classifier`).
 *  2. This function maps that neutral category onto wrap's `Outcome` vocabulary.
 *  3. The premium/refund MATH lives in `computeEconomics` (./economics) — the
 *     single source of truth shared with the facilitator path. wrap calls it
 *     WITHOUT `amountPaid`, so a covered breach refunds the canonical
 *     `imputedCost + flatPremium` (principal + premium; agent-tasks#11).
 *
 * - network error / no response  → network_error, premium=flat, refund=imputed+flat
 * - 5xx                          → server_error,  premium=flat, refund=imputed+flat
 * - 4xx (incl. 429)              → client_error,  premium=0,    refund=0
 * - 2xx + latency >  sla         → latency_breach, premium=flat, refund=imputed+flat
 * - 2xx + latency <= sla         → ok,            premium=flat, refund=0
 * - 1xx / 3xx / other (core      → ok,            premium=flat, refund=0
 *   `other`)                       (premium charged, no refund — a real
 *                                  Response only ever carries 3xx here, and it
 *                                  is not a covered breach; consumer plugins
 *                                  may override)
 */
export const defaultClassifier: Classifier = {
  classify({ response, latencyMs, endpointConfig }: ClassifierInput): ClassifierResult {
    const category = classifyHttpOutcome({
      statusCode: response === null ? null : response.status,
      latencyMs,
      latencyThresholdMs: endpointConfig.sla_latency_ms,
      networkError: response === null,
    });

    let outcome: Outcome;
    switch (category) {
      case "network_error":
        outcome = "network_error";
        break;
      case "server_error":
        outcome = "server_error";
        break;
      case "client_error":
        outcome = "client_error";
        break;
      case "slow":
        outcome = "latency_breach";
        break;
      case "success":
      case "other":
        // 2xx-within-SLA and 1xx/3xx/other both map to ok (premium, no refund).
        outcome = "ok";
        break;
    }

    const econ = computeEconomics({
      outcome,
      pool: {
        flatPremiumLamports: endpointConfig.flat_premium_lamports,
        imputedCostLamports: endpointConfig.imputed_cost_lamports,
      },
      // No `amountPaid`: the gateway path's principal is the parametric imputed
      // cost, so a covered breach refunds imputedCost + flatPremium.
    });
    return { outcome: econ.outcome, premium: econ.premiumLamports, refund: econ.refundLamports };
  },
};

/**
 * Helper for per-endpoint plugins to fall through to the default after their
 * own checks. Example (lives in the consumer, not in this lib):
 *
 * ```ts
 * import { defaultClassifier, composeWithDefault, Classifier } from "@pact-network/wrap";
 *
 * export const heliusJsonRpcClassifier: Classifier = {
 *   async classify(input) {
 *     // Plugin first: peek at JSON-RPC error code in the body.
 *     if (input.response && input.response.headers.get("content-type")?.includes("application/json")) {
 *       const body = await input.response.clone().json().catch(() => null);
 *       if (body && body.error && body.error.code === -32603) {
 *         return {
 *           outcome: "server_error",
 *           premium: input.endpointConfig.flat_premium_lamports,
 *           refund: input.endpointConfig.imputed_cost_lamports,
 *         };
 *       }
 *     }
 *     // Otherwise defer to the default rules.
 *     return defaultClassifier.classify(input);
 *   },
 * };
 * ```
 *
 * Note: `Classifier.classify` is sync in this interface for the hot path.
 * Plugins that need async inspection should pre-resolve in middleware before
 * calling wrapFetch, or define their own async wrapper. We keep the contract
 * sync to avoid forcing every consumer to await.
 */
export function composeWithDefault(
  pluginFn: (input: ClassifierInput) => ClassifierResult | null,
): Classifier {
  return {
    classify(input: ClassifierInput): ClassifierResult {
      const pluginResult = pluginFn(input);
      if (pluginResult !== null) return pluginResult;
      return defaultClassifier.classify(input);
    },
  };
}
