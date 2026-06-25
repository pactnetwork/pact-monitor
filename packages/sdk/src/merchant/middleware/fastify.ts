/**
 * Fastify adapter. Returns an `(app) => Promise<void>` hook installer that
 * mutates the user's app directly (not a registered plugin) so the hooks
 * apply to ALL routes on that app, not just routes registered inside an
 * encapsulated plugin scope.
 *
 * Usage: `await m.fastify(opts)(app);`
 *
 * Type-only framework import — see middleware/express.ts header.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  parseInbound,
  buildAttestation,
  postObservationFireAndForget,
  type MiddlewareDeps,
  type MiddlewareOptions,
} from "./shared.js";

interface PerRequestState {
  startedAtMonotonic: number;
  matchedPath: string;
  agentPubkey: string | null;
  startedAt: number;
}

// Module-private symbol so app code can't read/overwrite the per-request
// scratchpad we attach to the request object.
const STATE_KEY = Symbol("pactMerchantState");

export type FastifyMerchantInstaller = (app: FastifyInstance) => Promise<void>;

export function createFastifyPlugin(
  deps: MiddlewareDeps,
  options: MiddlewareOptions,
): FastifyMerchantInstaller {
  return async (app: FastifyInstance) => {
    app.addHook("onRequest", async (request: FastifyRequest) => {
      const inbound = parseInbound(
        request.headers as Record<string, string | string[] | undefined>,
        "",
      );
      (request as FastifyRequest & { [STATE_KEY]?: PerRequestState })[
        STATE_KEY
      ] = {
        startedAtMonotonic: Date.now(),
        matchedPath: "",
        agentPubkey: inbound.agentPubkey,
        startedAt: inbound.startedAt,
      };
    });

    app.addHook("onSend", async (request, reply: FastifyReply, payload) => {
      const state = (
        request as FastifyRequest & { [STATE_KEY]?: PerRequestState }
      )[STATE_KEY];
      if (!state) return payload;
      const matchedPath =
        (request as FastifyRequest & { routeOptions?: { url?: string } })
          .routeOptions?.url ?? request.url;
      state.matchedPath = matchedPath;
      const att = buildAttestation(
        deps,
        {
          agentPubkey: state.agentPubkey,
          startedAt: state.startedAt,
          matchedPath,
        },
        reply.statusCode,
      );
      if (att) {
        reply.header(att.headerName, att.headerValueBy);
        reply.header(att.headerSig, att.headerValueSig);
      }
      return payload;
    });

    app.addHook("onResponse", async (request, reply: FastifyReply) => {
      const state = (
        request as FastifyRequest & { [STATE_KEY]?: PerRequestState }
      )[STATE_KEY];
      if (!state) return;
      const latencyMs = Date.now() - state.startedAtMonotonic;
      postObservationFireAndForget(
        deps,
        options,
        {
          agentPubkey: state.agentPubkey,
          startedAt: state.startedAt,
          matchedPath: state.matchedPath,
        },
        reply.statusCode,
        latencyMs,
      );
    });
  };
}
