// J1-narrow: cross-package classifier parity.
//
// The wrap library (`@pact-network/wrap`) produces an `Outcome` enum used by
// the proxy + settler. The merchant SDK (`@q3labs/pact-sdk/merchant`)
// produces a `Classification` enum used by the merchant middleware and the
// backend's call_records.classification column. Both must agree on the same
// observable for the same input — if they drift, an agent recording via the
// merchant middleware and the same agent recording via the proxy would get
// different classifications for an identical (status, latency) tuple.
//
// This test pins the mapping. When the real consolidation into a shared
// classifier package happens (deferred — see plan), this parity test stays
// to gate any future drift.

import { describe, it, expect } from "vitest";
import { defaultClassifier as wrapClassifier } from "@pact-network/wrap";
import { defaultClassify } from "@q3labs/pact-sdk/merchant";

const SLA = 5_000;
const ENDPOINT_CONFIG = {
  sla_latency_ms: SLA,
  flat_premium_lamports: 100n,
  imputed_cost_lamports: 1_000n,
};

// wrap Outcome → SDK Classification mapping. wrap distinguishes
// `network_error` from `server_error`; the merchant SDK collapses both into
// `server_error` because the backend's call_records.classification CHECK
// doesn't include a network bucket.
function wrapToSdk(o: string): string {
  switch (o) {
    case "ok":
      return "success";
    case "server_error":
    case "network_error":
      return "server_error";
    case "client_error":
      return "client_error";
    case "latency_breach":
      return "timeout";
    default:
      throw new Error(`unmapped wrap outcome: ${o}`);
  }
}

function makeResponse(status: number): Response {
  // The WHATWG Response constructor rejects a body for 1xx/204/205/304;
  // pass null for those so the test exercises the classifier without
  // tripping over the Response spec.
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : "", { status });
}

describe("classifier parity (J1-narrow)", () => {
  const cases: Array<{
    name: string;
    status: number | null; // null = network error
    latencyMs: number;
  }> = [
    { name: "2xx fast",         status: 200, latencyMs: 50 },
    { name: "2xx at sla",       status: 200, latencyMs: SLA - 1 },
    { name: "2xx over sla",     status: 200, latencyMs: SLA + 1 },
    { name: "204 fast",         status: 204, latencyMs: 10 },
    { name: "301 redirect",     status: 301, latencyMs: 10 },
    { name: "400 client error", status: 400, latencyMs: 20 },
    { name: "401 unauthorized", status: 401, latencyMs: 20 },
    { name: "404 not found",    status: 404, latencyMs: 20 },
    { name: "429 rate-limited", status: 429, latencyMs: 30 },
    { name: "500 server error", status: 500, latencyMs: 20 },
    { name: "503 service down", status: 503, latencyMs: 100 },
    { name: "network error",    status: null, latencyMs: 0 },
  ];

  it.each(cases)("$name maps consistently", ({ status, latencyMs }) => {
    const wrapResult = wrapClassifier.classify({
      response: status === null ? null : makeResponse(status),
      latencyMs,
      endpointConfig: ENDPOINT_CONFIG,
    });
    // The merchant SDK classifier doesn't have a "network error" status — a
    // network-failure path is observed as a 5xx-equivalent server_error from
    // the backend's POV. Substitute 503 to elicit that bucket; we already
    // assert wrap's `network_error` collapses to `server_error` via wrapToSdk.
    const sdkClassification = defaultClassify({
      statusCode: status ?? 503,
      latencyMs,
      latencyThresholdMs: SLA,
    });
    // The default SDK classifier doesn't distinguish 3xx from 2xx (both
    // ok/success), and the wrap classifier treats 3xx as `ok` too — so the
    // mapping holds. The wrap classifier also returns `latency_breach` for
    // any 2xx + latency > sla; the SDK classifier checks latency BEFORE
    // status, so 2xx + over-sla → "timeout" (matching latency_breach).
    expect(sdkClassification).toBe(wrapToSdk(wrapResult.outcome));
  });
});
