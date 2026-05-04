import type { Classification, ExpectedSchema } from "./types.js";

export function classify(
  statusCode: number,
  latencyMs: number,
  latencyThresholdMs: number,
  responseBody: unknown,
  expectedSchema?: ExpectedSchema,
  networkError?: boolean,
): Classification {
  // Network unreachable / DNS failure / connection reset — provider's fault.
  if (networkError || statusCode === 0) {
    return "server_error";
  }

  // 4xx — agent's fault (bad URL, missing auth, rate-limited). Not claimable.
  if (statusCode >= 400 && statusCode < 500) {
    return "client_error";
  }

  // 5xx — provider's fault. Claimable.
  if (statusCode >= 500) {
    return "server_error";
  }

  // Anything outside 2xx that isn't 4xx/5xx (e.g. unhandled 3xx after redirects)
  // — treat as a server-side anomaly. Conservative.
  if (statusCode < 200 || statusCode >= 300) {
    return "server_error";
  }

  if (latencyMs > latencyThresholdMs) {
    return "timeout";
  }

  if (expectedSchema && responseBody !== undefined) {
    if (!matchesSchema(responseBody, expectedSchema)) {
      return "schema_mismatch";
    }
  }

  return "success";
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
