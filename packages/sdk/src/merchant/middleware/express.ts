/**
 * Express middleware adapter. Returns a plain Express-shaped middleware
 * `(req, res, next)` ready for `app.use(merchant.middleware(opts))`.
 *
 * Framework type-only import — runtime values are never touched, so a
 * consumer who hasn't installed express can still import this module
 * without a MODULE_NOT_FOUND.
 */
import type { Request, Response, NextFunction } from "express";
import {
  parseInbound,
  buildAttestation,
  postObservationFireAndForget,
  type MiddlewareDeps,
  type MiddlewareOptions,
} from "./shared.js";

export type ExpressMerchantMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

export function createExpressMiddleware(
  deps: MiddlewareDeps,
  options: MiddlewareOptions,
): ExpressMerchantMiddleware {
  return (req, res, next) => {
    // PR #223 Section C: when the middleware is mounted via
    // `app.use(merchant.middleware(...))`, Express has NOT yet matched the
    // route at the time this function runs. `req.route` is undefined here.
    // It only gets set when `Layer.handle_request` invokes the matching
    // route handler. So defer the matched-path read to the two deferred
    // call sites below (writeHead override + finish handler) — both fire
    // AFTER Express has matched the route, so `req.route?.path` is
    // populated. This lets parameterized routes like `/v1/items/:id` share
    // one pricing entry. Single-threaded JS guarantees the two reads see
    // the same `req.route`.
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const start = Date.now();
    const resolveInbound = () =>
      parseInbound(
        headers,
        (req as Request & { route?: { path?: string } }).route?.path ?? req.path,
      );

    // Stamp response headers BEFORE the response is sent. Hook into setHeader
    // by listening for the response 'header' event via writeHead override.
    const originalWriteHead = res.writeHead.bind(res);
    // Use `unknown` + cast: Express's writeHead has multiple overloads.
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead = (
      ...args: unknown[]
    ): Response => {
      try {
        const statusCode =
          typeof args[0] === "number" ? (args[0] as number) : res.statusCode;
        const inbound = resolveInbound();
        const att = buildAttestation(deps, inbound, statusCode);
        if (att) {
          res.setHeader(att.headerName, att.headerValueBy);
          res.setHeader(att.headerSig, att.headerValueSig);
        }
      } catch {
        /* never let header logic break the response */
      }
      return (originalWriteHead as unknown as (...a: unknown[]) => Response)(
        ...args,
      );
    };

    res.on("finish", () => {
      const latencyMs = Date.now() - start;
      const inbound = resolveInbound();
      postObservationFireAndForget(
        deps,
        options,
        inbound,
        res.statusCode,
        latencyMs,
      );
    });

    next();
  };
}
