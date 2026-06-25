/**
 * `merchant.observe()` — manual observation submission for non-Node servers
 * or for callers who want explicit control. Same wire format as the backend
 * `/api/v1/observations` endpoint.
 */
import type { MerchantClient } from "./client.js";
import type { Classification } from "./classifier.js";

export interface ObservationInput {
  agentPubkey?: string | null;
  endpoint: string;
  hostname?: string;
  startedAt: number;
  statusCode: number;
  latencyMs: number;
  classification: Classification;
  paymentHeaders?: Record<string, string>;
}

export interface ObservationResult {
  accepted: 0 | 1;
  recordId?: string;
}

export async function observe(
  client: MerchantClient,
  hostname: string,
  input: ObservationInput,
): Promise<ObservationResult> {
  const body: Record<string, unknown> = {
    hostname: input.hostname ?? hostname,
    endpoint: input.endpoint,
    startedAt: input.startedAt,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    classification: input.classification,
  };
  if (input.agentPubkey) body.agentPubkey = input.agentPubkey;
  if (input.paymentHeaders) body.paymentHeaders = input.paymentHeaders;
  const res = await client.postObservation(body);
  if (res.status === 200 || res.status === 201) {
    const parsed = res.body as { accepted?: number; recordId?: string } | null;
    return {
      accepted: (parsed?.accepted === 1 ? 1 : 0) as 0 | 1,
      recordId: parsed?.recordId,
    };
  }
  // The merchant SDK never throws from observe() on backend errors — the
  // golden rule mirror: backend hiccups are observable via the return shape,
  // not via exceptions. Callers can inspect `accepted === 0` and retry.
  return { accepted: 0 };
}
