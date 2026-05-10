import type { Envelope } from "../lib/envelope.ts";

// callId is a UUIDv4 produced by @pact-network/wrap. Validate the shape
// client-side so a typo doesn't burn a network round-trip.
const CALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function callsShowCommand(opts: {
  gatewayUrl: string;
  callId: string;
}): Promise<Envelope> {
  if (!CALL_ID_RE.test(opts.callId)) {
    return {
      status: "client_error",
      body: {
        error: "invalid_call_id",
        message:
          "Call IDs are UUIDv4 (e.g. 11111111-2222-4333-8444-555555555555). Pass a wallet pubkey to `pact agents show` instead.",
        call_id: opts.callId,
      },
    };
  }

  const url = `${opts.gatewayUrl.replace(/\/$/, "")}/v1/calls/${opts.callId}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const status = resp.status >= 500 ? "server_error" : "client_error";
    return {
      status,
      body: { http_status: resp.status, url, call_id: opts.callId },
    };
  }
  const body = await resp.json();
  return { status: "ok", body: body as Record<string, unknown> };
}
