import { classifyHttpOutcome } from "@pact-network/classifier";
import type { Classification, ExpectedSchema } from "./types.js";

export function classify(
  statusCode: number,
  latencyMs: number,
  latencyThresholdMs: number,
  responseBody: unknown,
  expectedSchema?: ExpectedSchema,
  networkError?: boolean,
): Classification {
  // The status -> category DECISION lives in the shared rails core
  // (@pact-network/classifier). This function maps the neutral category onto
  // monitor's Classification vocabulary, then layers monitor's own
  // schema-validation branch (which the core does not model) on top.
  const category = classifyHttpOutcome({
    statusCode,
    latencyMs,
    latencyThresholdMs,
    networkError,
  });

  switch (category) {
    // network/DNS/reset, 5xx, and anything outside 2xx-or-4xx (1xx, 3xx, >=600)
    // are all provider-side anomalies for monitoring purposes. Conservative.
    case "network_error":
    case "server_error":
    case "other":
      return "server_error";
    // 4xx — agent's fault (bad URL, missing auth, rate-limited). Not claimable.
    case "client_error":
      return "client_error";
    // 2xx over the latency threshold — provider's fault. Latency takes
    // precedence over schema (a slow-but-malformed 2xx is reported as timeout).
    case "slow":
      return "timeout";
    case "success":
      // monitor-only: a 2xx whose body fails the agent's expected shape is a
      // provider-returned-the-wrong-thing breach, not a clean success.
      if (expectedSchema && responseBody !== undefined) {
        if (!matchesSchema(responseBody, expectedSchema)) {
          return "schema_mismatch";
        }
      }
      return "success";
  }
}

function matchesSchema(body: unknown, schema: ExpectedSchema): boolean {
  if (schema.type === "object" && (typeof body !== "object" || body === null)) {
    return false;
  }
  if (schema.type === "array" && !Array.isArray(body)) {
    return false;
  }
  if (schema.required && typeof body === "object" && body !== null) {
    for (const key of schema.required) {
      if (!(key in body)) {
        return false;
      }
    }
  }
  return true;
}
