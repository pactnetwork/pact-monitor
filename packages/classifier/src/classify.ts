// @pact-network/classifier — the rails core.
//
// One decision tree, one neutral vocabulary. This is the single source of
// truth for "what kind of outcome was this API call?" Every consumer
// (wrap, monitor, the backend monitor route) calls this and then maps the
// neutral category onto its own output vocabulary + economics. The decision
// logic itself lives ONLY here.
//
// Dependency-light by contract: pure data in, enum out. No @solana/*, no db,
// no RPC, no server deps — the CLI can bundle this without dragging in the
// rest of the rails.

/**
 * Neutral SLA outcome category. Deliberately NOT any one consumer's vocabulary:
 *
 * - `success`        — 2xx within the latency threshold.
 * - `slow`           — 2xx but over the latency threshold (wrap: latency_breach,
 *                      monitor: timeout).
 * - `client_error`   — 4xx (incl. 429). The caller's fault; not a covered breach.
 * - `server_error`   — 5xx (500-599). The provider's fault; covered.
 * - `network_error`  — no response at all (network error / DNS / reset / status 0).
 *                      Distinct from server_error so consumers that care (wrap)
 *                      can label it; consumers that don't (monitor, backend)
 *                      fold it into their server-fault bucket.
 * - `other`          — anything that is neither a clean 2xx success nor a
 *                      recognized 4xx/5xx error: 1xx, 3xx, and >=600. wrap treats
 *                      these as `ok` (a real Response with such a status is rare
 *                      and not a covered breach); monitor/backend treat them
 *                      conservatively as a server-side anomaly. Keeping `other`
 *                      separate lets BOTH preserve their existing behavior with
 *                      no drift, instead of forcing one canonical answer.
 */
export type CoreCategory =
  | "success"
  | "slow"
  | "client_error"
  | "server_error"
  | "network_error"
  | "other";

export interface HttpOutcomeInput {
  /**
   * HTTP status code of the upstream response, or `null` when no response was
   * received (network error before any status). `0` is also treated as
   * "no response" for consumers that signal network failure that way.
   */
  statusCode: number | null;
  /** Observed round-trip latency in milliseconds. */
  latencyMs: number;
  /** SLA latency threshold in ms. A 2xx strictly above this is `slow`. */
  latencyThresholdMs: number;
  /**
   * Explicit network-failure signal. When true the call is `network_error`
   * regardless of statusCode (wrap passes this when the upstream fetch threw;
   * monitor passes it alongside statusCode 0).
   */
  networkError?: boolean;
}

/**
 * Map an HTTP call outcome to a neutral category. Pure; no side effects.
 *
 * Decision tree (first match wins):
 *   1. no response (networkError | statusCode null/0)  -> network_error
 *   2. 500-599                                          -> server_error
 *   3. 400-499                                          -> client_error
 *   4. 200-299 over threshold                           -> slow
 *   5. 200-299 within threshold                         -> success
 *   6. everything else (1xx, 3xx, >=600)                -> other
 */
export function classifyHttpOutcome(input: HttpOutcomeInput): CoreCategory {
  const { statusCode, latencyMs, latencyThresholdMs, networkError } = input;

  if (networkError || statusCode == null || statusCode === 0) {
    return "network_error";
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return "server_error";
  }
  if (statusCode >= 400 && statusCode <= 499) {
    return "client_error";
  }
  if (statusCode >= 200 && statusCode <= 299) {
    return latencyMs > latencyThresholdMs ? "slow" : "success";
  }
  return "other";
}
