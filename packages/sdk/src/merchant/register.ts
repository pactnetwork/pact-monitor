/**
 * `merchant.register()` — submits the merchant's hostname + endpoint pricing
 * to the backend for ops review. V1 path: backend persists `pending_review`,
 * ops runs the manual on-chain registration script (which requires the
 * protocol authority signer that the public API does not hold).
 */
import type { MerchantClient } from "./client.js";

export interface RegisterEndpointEntry {
  path: string;
  amountUsd: number;
}

export interface RegisterInput {
  hostname?: string;
  category?: string;
  endpoints: RegisterEndpointEntry[];
  preferredRateBps?: number;
}

export interface RegisterResult {
  id: string;
  status: "pending_review";
  etaHours?: number;
}

export async function registerEndpoint(
  client: MerchantClient,
  hostname: string,
  input: RegisterInput,
): Promise<RegisterResult> {
  const body: Record<string, unknown> = {
    hostname: input.hostname ?? hostname,
    endpoints: input.endpoints,
  };
  if (input.category) body.category = input.category;
  if (typeof input.preferredRateBps === "number") {
    body.preferredRateBps = input.preferredRateBps;
  }
  const res = (await client.postRegister(body)) as {
    id?: string;
    status?: string;
    etaHours?: number;
  } | null;
  // Commit 1: the backend route lands in Commit 2. Callers receive a stable
  // shape here; if the route 404s, the SDK still returns a usable object so
  // integrators can wire UI today and the live response shape stays
  // compatible when Commit 2 ships.
  return {
    id: res?.id ?? "pending",
    status: "pending_review",
    etaHours: res?.etaHours,
  };
}
