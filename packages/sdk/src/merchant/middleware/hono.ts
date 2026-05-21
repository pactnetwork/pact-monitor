/**
 * Hono middleware adapter. Returns a middleware function suitable for
 * `app.use('*', merchant.hono(opts))`.
 *
 * Type-only framework import — see middleware/express.ts header.
 */
import type { MiddlewareHandler } from "hono";
import {
  parseInbound,
  buildAttestation,
  postObservationFireAndForget,
  type MiddlewareDeps,
  type MiddlewareOptions,
} from "./shared.js";

export function createHonoMiddleware(
  deps: MiddlewareDeps,
  options: MiddlewareOptions,
): MiddlewareHandler {
  return async (c, next) => {
    // c.req.routePath returns the registered pattern for the CURRENT handler
    // — when this middleware is mounted with `app.use('*', ...)` that's "*",
    // not the eventual route handler's path. Use the request path so the
    // pricing-map lookup + attestation endpoint identifier match the user's
    // route entry verbatim.
    const matchedPath = c.req.path;
    // Build a plain object once so parseInbound can read all headers via
    // its uniform dictionary contract.
    const headersDict: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headersDict[key] = value;
    });
    const inbound = parseInbound(headersDict, matchedPath);
    const start = Date.now();

    await next();

    const latencyMs = Date.now() - start;
    const statusCode = c.res.status;

    const att = buildAttestation(deps, inbound, statusCode);
    if (att) {
      // Replace c.res with a new Response carrying the merged headers.
      // c.res.headers is read-only after the route handler constructs the
      // Response, so .set() on it silently no-ops in some runtimes; rebuild
      // the Response so the attestation actually rides on the wire.
      const merged = new Headers(c.res.headers);
      merged.set(att.headerName, att.headerValueBy);
      merged.set(att.headerSig, att.headerValueSig);
      c.res = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: merged,
      });
    }

    postObservationFireAndForget(deps, options, inbound, statusCode, latencyMs);
  };
}
