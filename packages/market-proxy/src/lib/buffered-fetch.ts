// Helper: a fetch shim that buffers the response body as text and parses it
// as JSON when the content-type allows. Used by the proxy route so the
// per-endpoint sync Classifier (e.g. Helius JSON-RPC) can inspect the body.
//
// Returned shape:
//   - `fetchImpl` — pass to wrapFetch as `opts.fetchImpl`. Returns a Response
//     whose body is a re-readable copy of the upstream body.
//   - `getParsedBody()` — synchronous accessor for the parsed JSON body
//     (or null if the body wasn't JSON or wasn't fetched yet).
//
// The shim itself is async (it awaits the upstream fetch), but exposing the
// parsed body via a sync getter is what lets us satisfy wrap's sync
// Classifier contract.
//
// Optionally, an async `preDelayMs` knob lets the proxy inject a sleep into
// the timing window measured by wrap — this is how Pact Market's
// force-breach demo mode causes wrap to classify the call as a
// `latency_breach` (the sleep happens *inside* wrap's stopwatch).

export interface BufferedFetch {
  /** Pass this to wrapFetch via `opts.fetchImpl`. */
  fetchImpl: typeof fetch;
  /** Synchronous accessor; null if not parsed (yet) or non-JSON. */
  getParsedBody: () => unknown;
  /** Raw text body, after the upstream fetch has resolved. */
  getRawBody: () => string | null;
}

export interface CreateBufferedFetchOptions {
  upstreamRequest: Request;
  realFetch?: typeof fetch;
  /**
   * Optional pre-fetch delay in milliseconds. Sleep happens inside the
   * fetchImpl call, so wrap's latency measurement includes it. Used by
   * force-breach demo mode to push the call past SLA.
   */
  preDelayMs?: number;
}

export function createBufferedFetch(opts: CreateBufferedFetchOptions): BufferedFetch {
  const realFetch = opts.realFetch ?? fetch;
  const upstreamReq = opts.upstreamRequest;
  const preDelayMs = opts.preDelayMs ?? 0;
  let parsed: unknown = null;
  let raw: string | null = null;

  const fetchImpl: typeof fetch = async (_input, _init) => {
    if (preDelayMs > 0) {
      await new Promise((r) => setTimeout(r, preDelayMs));
    }
    // We ignore the URL/init that wrap passes — we already have the prepared
    // upstream Request from the per-endpoint handler. wrapFetch does not
    // mutate the upstream URL.
    const resp = await realFetch(upstreamReq);
    // Buffer body once; reconstruct a Response for wrap to consume.
    const text = await resp.text();
    raw = text;
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return new Response(text, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  };

  return {
    fetchImpl,
    getParsedBody: () => parsed,
    getRawBody: () => raw,
  };
}
