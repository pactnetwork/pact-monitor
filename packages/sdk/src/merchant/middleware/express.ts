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
    // Matched-path key for pricing lookup: prefer the Express route pattern
    // (e.g. `/v1/generate-image`) so `:param`-style routes share one entry.
    // Fall back to req.path when no route is matched (404, sub-app boundary).
    const matchedPath =
      (req as Request & { route?: { path?: string } }).route?.path ?? req.path;
    const inbound = parseInbound(
      req.headers as Record<string, string | string[] | undefined>,
      matchedPath,
    );

    const start = Date.now();

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
