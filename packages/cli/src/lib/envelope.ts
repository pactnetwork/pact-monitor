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
  // pact pay outcomes — surface payment scheme + retry result through --json
  "x402_payment_made",
  "mpp_payment_made",
  "payment_failed",
  // pact pay-specific failure modes that must exit non-zero so shell chains
  // (`pact pay … && next-step`) stop on tool problems. These deliberately do
  // not reuse `client_error` (which maps to exit 0 to preserve the
  // envelope-first contract for the rest of the CLI).
  "unsupported_tool",
  "tool_missing",
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
  // x402/MPP retries that succeeded — exit 0; the wrapped tool's exit code is
  // surfaced inside body.tool_exit_code so callers can chain on it.
  x402_payment_made: 0,
  mpp_payment_made: 0,
  // pact pay reached a 402 challenge but the retry was rejected or unsupported.
  payment_failed: 31,
  // pact pay invoked with a tool we don't wrap yet (e.g. wget) — non-zero so
  // shell chains stop instead of silently continuing.
  unsupported_tool: 50,
  // pact pay's wrapped tool isn't on PATH (e.g. curl uninstalled).
  tool_missing: 51,
  cli_internal_error: 99,
};

export function exitCodeFor(status: Status): number {
  return exitCodeMap[status];
}

export function makeEnvelope(status: Status, body?: unknown, meta?: EnvelopeMeta): Envelope {
  return meta !== undefined ? { status, body, meta } : { status, body };
}

// TODO(friday-harden): surface stack traces behind PACT_LOG=debug or --verbose.
// Until then, we deliberately exclude err.stack to avoid leaking internal paths
// (B3 — see review of PR #64).
export function buildInternalErrorEnvelope(err: unknown): Envelope {
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: "cli_internal_error",
    body: { error: message },
  };
}
