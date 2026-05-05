export const statuses = [
  "ok",
  "client_error",
  "server_error",
  "needs_funding",
  "auto_deposit_capped",
  "endpoint_paused",
  "no_provider",
  "discovery_unreachable",
  "signature_rejected",
  "needs_project_name",
  "cli_internal_error",
] as const;

export type Status = (typeof statuses)[number];

export type Outcome = "ok" | "client_error" | "server_error";

export interface EnvelopeMeta {
  slug?: string;
  call_id?: string;
  latency_ms?: number;
  outcome?: Outcome;
  premium_lamports?: number;
  premium_usdc?: number;
  tx_signature?: string | null;
  settlement_eta_sec?: number;
  [k: string]: unknown;
}

export interface Envelope {
  status: Status;
  body?: unknown;
  meta?: EnvelopeMeta;
  [k: string]: unknown;
}

const exitCodeMap: Record<Status, number> = {
  ok: 0,
  client_error: 0,
  server_error: 0,
  needs_funding: 10,
  auto_deposit_capped: 11,
  endpoint_paused: 12,
  no_provider: 20,
  discovery_unreachable: 21,
  signature_rejected: 30,
  needs_project_name: 40,
  cli_internal_error: 99,
};

export function exitCodeFor(status: Status): number {
  return exitCodeMap[status];
}

export function makeEnvelope(status: Status, body?: unknown, meta?: EnvelopeMeta): Envelope {
  return meta !== undefined ? { status, body, meta } : { status, body };
}
