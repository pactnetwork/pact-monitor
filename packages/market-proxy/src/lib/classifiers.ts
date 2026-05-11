// Per-endpoint classifier plugins for Pact Market.
//
// Each plugin composes with `defaultClassifier` from @pact-network/wrap via
// `composeWithDefault`. Plugins run BEFORE the default rules — they may
// short-circuit (return a ClassifierResult) or fall through (return null).
//
// Some plugins (Helius JSON-RPC) need to inspect the response body. Since the
// wrap Classifier interface is synchronous (so the hot path doesn't have to
// await), the proxy route pre-buffers the body via `bufferedFetch` and passes
// the parsed body to the plugin via a closure factory.

import {
  composeWithDefault,
  defaultClassifier,
  type Classifier,
  type ClassifierInput,
  type ClassifierResult,
} from "@pact-network/wrap";

const ZERO = 0n;

/**
 * Default Pact Market classifier — used by endpoints that don't need to
 * peek at the response body (Birdeye, Jupiter, fal, Elfa). Behaviour is
 * identical to wrap's `defaultClassifier`; we re-export it here so the
 * registry has a uniform shape.
 */
export const marketDefaultClassifier: Classifier = defaultClassifier;

/**
 * Build a Helius JSON-RPC classifier given a function that yields the
 * already-parsed body (or null if the body wasn't JSON / wasn't readable).
 *
 * Helius (and other JSON-RPC providers) can return HTTP 200 with a
 * `body.error.code` payload. We map a couple of known JSON-RPC codes to
 * Pact outcomes:
 *
 *   - -32603 (internal) / -32000..-32099 (server-defined) → server_error
 *     with full premium and refund (a real upstream failure dressed as 200)
 *   - -32602 (invalid params), -32601 (method not found), -32600 (invalid
 *     request), -32700 (parse error) → client_error, no premium
 *   - any other JSON-RPC error → client_error (conservative)
 *
 * Latency check: any 2xx response (200, 201, 202, 204, ...) over the SLA
 * is classified as `latency_breach` first — this matches the Birdeye /
 * Jupiter classifiers (which use defaultClassifier directly) and prevents
 * a slow-but-200 JSON-RPC error response from masking the SLA breach.
 *
 * If the response is not 2xx, or the body has no `error`, fall through
 * to the default rules.
 */
export function buildHeliusClassifier(
  getBody: () => unknown,
): Classifier {
  return composeWithDefault((input: ClassifierInput): ClassifierResult | null => {
    if (input.response === null) return null; // network error → default

    const status = input.response.status;
    const flat = input.endpointConfig.flat_premium_lamports;
    const imputed = input.endpointConfig.imputed_cost_lamports;

    // Hoist the SLA latency check so it applies to ANY 2xx response, not
    // just 200. Mirrors the default classifier's 2xx branch but runs BEFORE
    // body inspection so a slow JSON-RPC-error response is still recorded
    // as `latency_breach`.
    if (status >= 200 && status <= 299) {
      if (input.latencyMs > input.endpointConfig.sla_latency_ms) {
        return { outcome: "latency_breach", premium: flat, refund: imputed };
      }
    } else {
      // Non-2xx → defer entirely to default HTTP-status rules.
      return null;
    }

    const body = getBody() as { error?: { code?: number } } | null;
    if (!body || typeof body !== "object" || !body.error) return null;

    const code = body.error.code;

    if (code === -32603 || (typeof code === "number" && code <= -32000 && code >= -32099)) {
      return { outcome: "server_error", premium: flat, refund: imputed };
    }
    // Any other JSON-RPC error → client error, agent eats it (no premium).
    return { outcome: "client_error", premium: ZERO, refund: ZERO };
  });
}

/**
 * Per-endpoint classifier registry. The proxy route picks a classifier by
 * endpoint slug. For Helius, we get a *factory* that closes over the parsed
 * body; for everything else, the classifier is body-agnostic and reusable.
 */
export type ClassifierFactory =
  | { kind: "static"; classifier: Classifier }
  | { kind: "needsBody"; build: (getBody: () => unknown) => Classifier };

export const classifierRegistry: Record<string, ClassifierFactory> = {
  helius: { kind: "needsBody", build: buildHeliusClassifier },
  birdeye: { kind: "static", classifier: marketDefaultClassifier },
  jupiter: { kind: "static", classifier: marketDefaultClassifier },
  elfa: { kind: "static", classifier: marketDefaultClassifier },
  fal: { kind: "static", classifier: marketDefaultClassifier },
  // `dummy` returns plain HTTP (not JSON-RPC), so the simple status-based
  // default classifier is the right fit: 5xx → server_error+refund,
  // 2xx-over-SLA → latency_breach+refund, 4xx (incl. 402) → client_error.
  dummy: { kind: "static", classifier: marketDefaultClassifier },
};
