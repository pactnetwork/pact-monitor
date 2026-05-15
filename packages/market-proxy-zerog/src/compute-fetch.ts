// The one genuinely new mechanism in the port: a `typeof fetch` shim that
// turns a 0G-Compute inference round-trip into the upstream `Response`
// wrapFetch times + classifies. wrapFetch's stopwatch wraps this whole
// closure, so any `preDelayMs` (force-breach demo) is naturally counted as
// latency, and a thrown inference becomes a 502 → `server_error` → refund.
//
// `getServiceMetadata` is NOT called here — `endpoint`/`model` are resolved
// once at boot and passed in (plan 5.A), so the timed window is just the
// signed `getRequestHeaders` + the inference fetch, not provider discovery.

/** Structural subset of `ZerogComputeClient` the shim needs (DI for tests;
 *  the concrete CJS client is constructed in context.ts via default import,
 *  plan 5.E). */
export interface InferenceCaller {
  callInferenceWith(opts: {
    provider: string;
    endpoint: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
    teeVerify?: boolean;
  }): Promise<{
    body: unknown;
    latencyMs: number;
    chatId: string | null;
    teeVerified: boolean | null;
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeComputeFetchImpl(opts: {
  zerogCompute: InferenceCaller;
  provider: string;
  endpoint: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  preDelayMs?: number;
  teeVerify?: boolean;
}): typeof fetch {
  const impl = async (): Promise<Response> => {
    if (opts.preDelayMs && opts.preDelayMs > 0) {
      await sleep(opts.preDelayMs);
    }
    try {
      const r = await opts.zerogCompute.callInferenceWith({
        provider: opts.provider,
        endpoint: opts.endpoint,
        model: opts.model,
        messages: opts.messages,
        teeVerify: opts.teeVerify,
      });
      return new Response(JSON.stringify(r.body), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-zerog-chat-id': r.chatId ?? '',
          'x-zerog-tee-verified': String(r.teeVerified),
        },
      });
    } catch (err) {
      // Structured 502 (NOT a rethrow): wrap's own catch would mark this
      // `network_error`; a 502 → `server_error` is identical for premium/
      // refund but clearer in the evidence blob's `status`.
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: 'zerog_compute_failed', message }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }
  };
  return impl as typeof fetch;
}
